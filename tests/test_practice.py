"""Practice must be grounded, repeatable, bounded and separate from assessment."""
import copy
import json
import uuid
from types import SimpleNamespace

import pytest
from preview_client import PreviewClient as TestClient

from backend import ai_coach, ai_evaluator
from backend.coaching import recommendations, needs_practice, guidance, GENERIC_GUIDANCE
from backend.main import create_app, digest, semantic_hash
from backend.evaluation_policy import EVALUATION_POLICY_VERSION
from backend.scoring_engine import default_checklist, score_evaluation

HEADERS = {"X-Role": "operator"}


@pytest.fixture
def practice(tmp_path, monkeypatch):
    monkeypatch.delenv("QA_SUPERVISOR_TOKEN", raising=False)
    monkeypatch.setenv("OPENAI_MAX_CALLS", "3")
    app = create_app(tmp_path / "store.json", tmp_path / "missing.json")
    store = app.state.store
    c = default_checklist()[6]
    record = {"conversation_id": "one", "language": "RU", "channel": "agent chat", "transcript": [
        {"speaker": "client", "text": "Нашла тариф, спасибо.", "timestamp": "00:00"},
        {"speaker": "operator", "text": "До свидания!", "timestamp": "00:10"},
    ]}
    rows = [{"criterion_id": "07", "value": 0, "is_na": False, "reason": "Не предложена помощь и не подведён итог.",
             "proof_quote": "До свидания!", "proof_timestamp": "00:10", "proof_message_index": 1}]
    store.data["records"] = {"one": record}
    store.data["checklist"] = {"version": 1, "criteria": [c]}
    store.data["evaluations"] = {"one": {"id": "eval-one", "results": rows, **score_evaluation([c], rows),
        "policy_version": EVALUATION_POLICY_VERSION, "semantic_hash": semantic_hash([c]), "transcript_hash": digest(record), "created_at": "2026-11-07T10:00:00Z"}}
    store.save()
    calls = []
    def review(exercise, answer, language):
        calls.append((exercise, answer, language))
        return {"value": 1, "status": "COMPLETED", "worked": "Предложена помощь и есть прощание.",
                "improve": "", "why": "Обе части правила выполнены.", "answer_quote": answer[:180],
                "usage": {"prompt_tokens": 12, "completion_tokens": 8}, "model": "test-no-network"}
    monkeypatch.setattr(ai_coach, "review", review)
    return TestClient(app), store, calls


def body_for(client, answer="Могу ещё чем-то помочь? Хорошего дня!", **overrides):
    exercise = client.get("/api/practice/one/07", headers=HEADERS).json()
    return {"exercise_key": exercise["exercise_key"], "evaluation_id": exercise["evaluation_id"],
            "answer": answer, "language": "ru", "request_id": str(uuid.uuid4()), **overrides}


def submit(client, body):
    return client.post("/api/practice/one/07", headers=HEADERS, json=body)


def test_recommendations_and_exercise_are_free_and_preserve_evidence(practice):
    client, store, calls = practice
    before = copy.deepcopy(store.data)
    detail = client.get("/api/conversations/one").json()
    assert detail["coaching"][0]["source"] == "rule"
    assert "Одного прощания недостаточно" in detail["coaching"][0]["recommendation"]
    exercise = client.get("/api/practice/one/07", headers=HEADERS).json()
    assert exercise["context"][1]["text"] == "До свидания!"
    assert exercise["target_message_index"] == 1 and not exercise["attempts"]
    assert store.data == before and calls == []


def test_feedback_and_retries_persist_without_mutating_original_score(practice):
    client, store, calls = practice
    original = copy.deepcopy(store.data["evaluations"])
    body = body_for(client)
    response = submit(client, body)
    assert response.status_code == 200
    assert response.json()["attempt"]["status"] == "COMPLETED"
    assert response.json()["cached"] is False
    assert submit(client, body).json()["cached"] is True
    assert submit(client, {**body, "request_id": str(uuid.uuid4())}).json()["cached"] is True
    assert len(calls) == 1
    assert store.data["evaluations"] == original
    assert store.data["budget"] == {"attempts": 1, "prompt_tokens": 12, "completion_tokens": 8}
    reloaded = TestClient(create_app(store.path, store.path.parent / "absent.json"))
    attempts = reloaded.get("/api/practice/one/07", headers=HEADERS).json()["attempts"]
    assert len(attempts) == 1 and attempts[0]["answer"] == body["answer"]
    assert submit(reloaded, body).json()["cached"] is True


def test_changed_answer_uses_new_attempt_and_same_request_id_cannot_change_payload(practice):
    client, store, calls = practice
    body = body_for(client)
    assert submit(client, body).status_code == 200
    assert submit(client, {**body, "answer": "Другой ответ"}).status_code == 409
    assert submit(client, body_for(client, answer="Тариф найден. Всего доброго!")).status_code == 200
    assert len(calls) == 2


def test_budget_missing_key_and_empty_answer_do_not_call_model(practice, monkeypatch):
    client, store, calls = practice
    body = body_for(client)
    assert submit(client, {**body, "answer": " "}).status_code == 422
    assert submit(client, {**body, "answer": "x" * 5001}).status_code == 422
    monkeypatch.setenv("OPENAI_API_KEY", "")
    assert submit(client, body).status_code == 503
    monkeypatch.setenv("OPENAI_API_KEY", "test-placeholder")
    monkeypatch.setenv("OPENAI_MAX_CALLS", "0")
    assert submit(client, body).status_code == 429
    assert not calls and store.data["budget"]["attempts"] == 0


def test_unlimited_practice_still_tracks_usage_and_reuses_saved_feedback(practice, monkeypatch):
    client, store, calls = practice
    monkeypatch.setenv("OPENAI_MAX_CALLS", "unlimited")
    for index in range(4):
        body = body_for(client, answer=f"Ваш тариф найден. Могу ещё чем-то помочь? Вариант {index}")
        response = submit(client, body)
        assert response.status_code == 200
    assert response.json()["budget"]["unlimited"]
    assert response.json()["budget"]["remaining"] is None
    assert submit(client, body).json()["cached"]
    assert len(calls) == 4
    assert store.data["budget"] == {"attempts": 4, "prompt_tokens": 48, "completion_tokens": 32}


def test_failed_attempt_reserved_once_and_usage_recorded(practice, monkeypatch):
    client, store, calls = practice
    def fail(*_):
        raise ai_evaluator.EvaluationValidationError("bad", {"prompt_tokens": 6, "completion_tokens": 2})
    monkeypatch.setattr(ai_coach, "review", fail)
    body = body_for(client)
    assert submit(client, body).status_code == 502
    assert submit(client, body).status_code == 502
    assert store.data["budget"] == {"attempts": 1, "prompt_tokens": 6, "completion_tokens": 2}
    assert not store.practice_active and not store.data.get("practice_attempts")


def test_reservation_failure_never_calls_model(practice, monkeypatch):
    client, store, calls = practice
    body = body_for(client)
    monkeypatch.setattr("backend.main.os.replace", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
    assert submit(client, body).status_code == 503
    assert not calls and store.data["budget"]["attempts"] == 0 and not store.practice_active


def test_completed_response_can_be_reused_with_exhausted_budget(practice, monkeypatch):
    client, store, calls = practice
    body = body_for(client)
    assert submit(client, body).status_code == 200
    monkeypatch.setenv("OPENAI_MAX_CALLS", "1")
    assert submit(client, {**body, "request_id": str(uuid.uuid4())}).json()["cached"] is True
    assert submit(client, body_for(client, answer="Изменённый ответ")).status_code == 429
    assert len(calls) == 1


def test_feedback_save_failure_rolls_back_and_counts_usage_once(practice, monkeypatch):
    client, store, calls = practice
    body = body_for(client)
    import backend.main as main
    replace = main.os.replace
    count = 0
    def fail_once(*args):
        nonlocal count
        count += 1
        if count == 2:
            raise OSError("disk full")
        return replace(*args)
    monkeypatch.setattr(main.os, "replace", fail_once)
    assert submit(client, body).status_code == 502
    assert not store.data.get("practice_attempts")
    assert store.data["budget"] == {"attempts": 1, "prompt_tokens": 12, "completion_tokens": 8}
    assert len(calls) == 1 and not store.practice_active


def test_stale_context_and_changed_override_rejected_before_charge(practice):
    client, store, calls = practice
    body = body_for(client)
    store.data["evaluations"]["one"]["results"][0]["override_comment"] = "Новое решение"
    assert submit(client, body).status_code == 409
    store.data["checklist"]["criteria"][0]["description"] = "Новое правило"
    assert client.get("/api/conversations/one").json()["coaching"] == []
    assert client.get("/api/practice/one/07", headers=HEADERS).status_code == 409
    assert not calls and store.data["budget"]["attempts"] == 0


def test_changed_evaluation_during_call_discards_feedback_but_counts_attempt(practice, monkeypatch):
    client, store, calls = practice
    original = ai_coach.review
    def change(*args):
        result = original(*args)
        store.data["evaluations"]["one"]["id"] = "new-evaluation"
        store.save()
        return result
    monkeypatch.setattr(ai_coach, "review", change)
    assert submit(client, body_for(client)).status_code == 409
    assert store.data["budget"]["attempts"] == 1
    assert not store.data.get("practice_attempts") and not store.practice_active


def test_all_criterion_types_na_overrides_and_custom_rules():
    criteria = default_checklist()
    assert needs_practice(criteria[0], {"value": 0, "is_na": False})
    assert needs_practice(criteria[3], {"value": 15, "is_na": False})
    assert not needs_practice(criteria[3], {"value": 20, "is_na": False})
    assert needs_practice(criteria[-1], {"value": 1, "is_na": False})
    assert not needs_practice(criteria[-1], {"value": 0, "is_na": False})
    assert not needs_practice(criteria[1], {"value": None, "is_na": True})
    c = {**criteria[6], "description": "Спросите, удобно ли продолжить завтра."}
    assert guidance(c, {})[:2] == GENERIC_GUIDANCE
    r = {"recommendation": "Конкретный совет", "practice_task": "Задание"}
    assert guidance(c, r)[2] == "ai"
    assert guidance(c, {**r, "override_comment": "Решение руководителя"})[2] == "rule"


def test_role_token_and_parallel_guard(practice, monkeypatch):
    client, store, calls = practice
    body = body_for(client)
    monkeypatch.setenv("QA_SUPERVISOR_TOKEN", "secret")
    assert client.get("/api/practice/one/07", headers={"X-Role": "invalid"}).status_code == 403
    assert client.post("/api/practice/one/07", headers={"X-Role": "supervisor"}, json=body).status_code == 403
    store.practice_active.add(body["exercise_key"])
    assert submit(client, body).status_code == 409
    assert not calls


def mock_completion(monkeypatch, payload, finish="stop"):
    captured = {}
    response = SimpleNamespace(model="test", usage=SimpleNamespace(prompt_tokens=1, completion_tokens=2, total_tokens=3),
        choices=[SimpleNamespace(finish_reason=finish, message=SimpleNamespace(refusal=None, content=json.dumps(payload)))])
    def client(**options):
        assert options["max_retries"] == 0
        def create(**kwargs):
            captured.update(kwargs)
            return response
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    monkeypatch.setattr(ai_coach, "OpenAI", client)
    return captured


@pytest.mark.parametrize("index,value,status", [(0, 0, "NEEDS_WORK"), (0, 1, "COMPLETED"), (3, 15, "NEEDS_WORK"), (3, 20, "COMPLETED"), (7, 0, "COMPLETED"), (7, 1, "NEEDS_WORK")])
def test_ai_coach_uses_exact_rule_and_derives_status(monkeypatch, index, value, status):
    payload = {"value": value, "worked": "Есть ответ.", "improve": "Уточните второй вопрос.", "why": "По правилу.", "answer_quote": "Мой ответ"}
    captured = mock_completion(monkeypatch, payload)
    c = default_checklist()[index]
    exercise = {"criterion": c, "task": "Задание", "issue": "Ошибка", "context": [], "target_message_index": 1}
    result = ai_coach.review(exercise, "Мой ответ", "kk")
    assert result["status"] == status
    assert captured["response_format"]["json_schema"]["strict"] is True
    supplied = json.loads(captured["messages"][1]["content"])
    assert supplied["criterion"] == c and supplied["feedback_language"] == "қазақша"
    assert captured["max_tokens"] <= 1400


@pytest.mark.parametrize("patch,finish", [({"answer_quote": "Выдуманная цитата"}, "stop"), ({"value": 99}, "stop"), ({}, "length"), ({"value": 0, "improve": ""}, "stop")])
def test_ai_coach_rejects_unverified_or_incomplete_feedback(monkeypatch, patch, finish):
    payload = {"value": 1, "worked": "Хорошо", "improve": "", "why": "Правило выполнено", "answer_quote": "Мой ответ", **patch}
    mock_completion(monkeypatch, payload, finish)
    exercise = {"criterion": default_checklist()[0], "task": "Задание", "issue": "Ошибка", "context": [], "target_message_index": 0}
    with pytest.raises(ai_evaluator.EvaluationValidationError) as exc:
        ai_coach.review(exercise, "Мой ответ", "ru")
    assert exc.value.usage["total_tokens"] == 3

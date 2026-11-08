"""Independent real-route privacy review with plain TestClient and fake transport."""
import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import ai_gateway
from backend.main import create_app

SUPERVISOR = {"X-Role": "supervisor", "X-Supervisor-Token": "review-test-secret"}
OPERATOR = {"X-Role": "operator"}


@pytest.fixture
def reviewed(tmp_path, monkeypatch):
    monkeypatch.setenv("QA_SUPERVISOR_TOKEN", "review-test-secret")
    monkeypatch.setenv("OPENAI_MAX_CALLS", "10")
    monkeypatch.setenv("OPENAI_ASSISTANT_MAX_CALLS", "2")
    dataset = tmp_path / "synthetic.json"
    records = [{"conversation_id": cid, "language": language, "channel": "agent chat", "audio_url": None,
                "transcript": [{"speaker": "client", "timestamp": "00:00", "text": "Мой email secret@example.invalid. Когда ответ?"},
                               {"speaker": "operator", "timestamp": "00:02", "text": "Здравствуйте, меня зовут Анна. Ответ через 3 дня."}]}
               for cid, language in (("one", "RU"), ("two", "KZ"))]
    dataset.write_text(json.dumps({"isSuccess": True, "data": {"dataset_group_id": "DEV", "total_records": 2, "records": records}}))
    client = TestClient(create_app(tmp_path / "store.json", dataset))
    calls = []
    def factory(**kwargs):
        def create(**request):
            calls.append(request)
            sent = json.loads(request["messages"][1]["content"])
            name = request["response_format"]["json_schema"]["name"]
            if name == "cqa_evaluation":
                result = {"status": "evaluated", "manual_review": None, "results": {c["id"]: {"criterion_id": c["id"], "value": False if c["source_id"] == "07" or c["type"] == "flag" else True if c["type"] == "binary" else c["max_scale"],
                    "rationale": "Нет завершения." if c["source_id"] == "07" else "Выполнено.",
                    "proof_turn": 2, "evidence_turns": [2],
                    "recommendation": "Подведите итог." if c["source_id"] == "07" else "", "practice_task": "Завершите ответ." if c["source_id"] == "07" else ""}
                    for c in sent["checklist"]}}
            elif name == "cqa_practice":
                result = {"value": 1, "worked": "Есть итог.", "improve": "", "why": "Критерий выполнен.", "answer_quote": sent["answer"]}
            elif name == "cqa_manager_search":
                fields = request["response_format"]["json_schema"]["schema"]["properties"]["filters"]["properties"]
                result = {"kind": "search", "operation": "merge", "filters": {key: None for key in fields}, "clear_fields": [], "clarification": None}
            else:
                result = {"selected_ids": [sent["server_candidates"][0]["id"]]}
            return SimpleNamespace(model="fake", usage=SimpleNamespace(prompt_tokens=2, completion_tokens=3, total_tokens=5),
                choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(refusal=None, content=json.dumps(result)))])
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    monkeypatch.setattr(ai_gateway, "OpenAI", factory)
    monkeypatch.setattr("backend.ai_evaluator.OpenAI", factory)
    monkeypatch.setattr("backend.ai_coach.OpenAI", factory)
    return client, calls


def preview(client, body, headers=SUPERVISOR):
    response = client.post("/api/ai/prepare", json=body, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def evaluate(client, cid="one", force=False):
    prepared = preview(client, {"purpose": "evaluation", "conversation_id": cid, "force": force})
    return client.post(f"/api/evaluate/{cid}?force={'true' if force else 'false'}", headers={**SUPERVISOR, "X-AI-Preview": prepared["preview_id"]})


def test_all_live_sends_require_exact_preview_and_mask_actual_transport(reviewed):
    client, calls = reviewed
    assert client.post("/api/evaluate/one", headers=SUPERVISOR).status_code == 428
    prepared = preview(client, {"purpose": "evaluation", "conversation_id": "one"})
    assert client.post("/api/evaluate/two", headers={**SUPERVISOR, "X-AI-Preview": prepared["preview_id"]}).status_code == 409
    result = client.post("/api/evaluate/one", headers={**SUPERVISOR, "X-AI-Preview": prepared["preview_id"]})
    assert result.status_code == 200
    assert calls[0] == prepared["requests"][0]["request"]
    assert "secret@example.invalid" not in json.dumps(calls)
    assert "Анна" not in json.dumps(calls, ensure_ascii=False)
    assert "Анна" in result.json()["evaluation"]["results"][0]["proof_quote"]
    assert client.post("/api/evaluate/one?force=true", headers=SUPERVISOR).status_code == 428


def test_changed_policy_and_changed_data_invalidate_previews(reviewed):
    client, calls = reviewed
    first = preview(client, {"purpose": "evaluation", "conversation_id": "one"})
    client.app.state.store.data["records"]["one"]["transcript"][1]["text"] += " Новые данные."
    assert client.post("/api/evaluate/one", headers={**SUPERVISOR, "X-AI-Preview": first["preview_id"]}).status_code == 409
    second = preview(client, {"purpose": "evaluation", "conversation_id": "one"})
    saved = client.post("/api/ai/privacy", headers=SUPERVISOR, json={"mask_personal_data": True, "block_external_ai": True})
    assert saved.status_code == 200
    assert client.post("/api/evaluate/one", headers={**SUPERVISOR, "X-AI-Preview": second["preview_id"]}).status_code == 403
    assert calls == [] and client.get("/api/health").json()["budget"]["attempts"] == 0


def test_batch_and_forced_reassessment_use_gateway_and_stop_when_blocked(reviewed):
    client, calls = reviewed
    prepared = preview(client, {"purpose": "batch", "conversation_ids": ["one", "two"]})
    response = client.post("/api/evaluate-batch", headers={**SUPERVISOR, "X-AI-Preview": prepared["preview_id"]}, json={"conversation_ids": ["one", "two"]})
    assert response.status_code == 200 and len(response.json()["completed"]) == 2
    assert calls == [request["request"] for request in prepared["requests"]]
    assert evaluate(client, force=True).status_code == 200 and len(calls) == 3
    assert all(request["store"] is False for request in calls)
    assert all("secret@example.invalid" not in json.dumps(request) for request in calls)
    client.post("/api/ai/privacy", headers=SUPERVISOR, json={"mask_personal_data": False, "block_external_ai": True})
    assert client.post("/api/evaluate/one?force=true", headers=SUPERVISOR).status_code == 403
    assert len(calls) == 3


def test_practice_preview_binds_answer_and_protects_new_answer(reviewed):
    client, calls = reviewed
    assert evaluate(client).status_code == 200
    exercise = client.get("/api/practice/one/07", headers=OPERATOR).json()
    answer = "Итог отправлен test@example.invalid, до свидания."
    prepared = preview(client, {"purpose": "practice", "conversation_id": "one", "criterion_id": "07", "answer": answer}, OPERATOR)
    body = {"exercise_key": exercise["exercise_key"], "evaluation_id": exercise["evaluation_id"], "answer": answer,
            "language": "ru", "request_id": str(uuid.uuid4()), "preview_id": prepared["preview_id"]}
    bad = client.post("/api/practice/one/07", headers=OPERATOR, json={**body, "answer": "Другой ответ"})
    assert bad.status_code == 409
    good = client.post("/api/practice/one/07", headers=OPERATOR, json=body)
    assert good.status_code == 200, good.text
    assert calls[-1] == prepared["requests"][0]["request"]
    assert "test@example.invalid" not in json.dumps(calls[-1])
    assert good.json()["attempt"]["answer_quote"] == answer


def test_assistant_uses_server_role_and_separate_shared_budgets(reviewed):
    client, calls = reviewed
    for headers in (OPERATOR, {"X-Role": "supervisor"}):
        assert client.post("/api/ai/prepare", headers=headers, json={"purpose": "assistant_search", "query": "Все"}).status_code == 403
        assert client.get("/api/assistant/history", headers=headers).status_code == 403
    for _ in range(2):
        prepared = preview(client, {"purpose": "assistant_search", "query": "Покажи для secret@example.invalid"})
        sent = client.post("/api/assistant", headers=SUPERVISOR, json={"preview_id": prepared["preview_id"]})
        assert sent.status_code == 200
        assert calls[-1] == prepared["requests"][0]["request"]
        payload = json.loads(calls[-1]["messages"][1]["content"])
        assert "transcript" not in payload and "records" not in payload and "evaluations" not in payload
    assert client.post("/api/ai/prepare", headers=SUPERVISOR, json={"purpose": "assistant_search", "query": "Все"}).status_code == 429
    health = client.get("/api/health").json()
    assert health["budget"]["attempts"] == 2 and health["assistant_budget"]["attempts"] == 2
    assert health["budget"]["limit"] == 10
    assert "secret@example.invalid" not in json.dumps(calls)


def test_preparation_error_is_generic_and_does_not_reserve_or_send(reviewed, monkeypatch):
    client, calls = reviewed
    def fail(*args):
        raise RuntimeError("secret@example.invalid")
    monkeypatch.setattr(ai_gateway.LocalMasker, "mask", fail)
    response = client.post("/api/ai/prepare", headers=SUPERVISOR, json={"purpose": "evaluation", "conversation_id": "one"})
    assert response.status_code == 422 and "secret@example.invalid" not in response.text
    assert calls == [] and client.get("/api/health").json()["budget"]["attempts"] == 0

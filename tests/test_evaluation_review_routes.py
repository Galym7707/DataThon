"""Manual-review integration with previews, budgets and existing saved scores."""
from backend import ai_evaluator
from tests.test_ai_requests import boundary, evaluate, preview, SUP, OP
import json
import pytest


def require_review(*args, **kwargs):
    raise ai_evaluator.ManualReviewRequired(
        "Нельзя достоверно определить ответ оператора.", "insufficient_evidence",
        {"prompt_tokens": 7, "completion_tokens": 3})


@pytest.mark.parametrize("message,expected_code", [
    ("Цитата ИИ не найдена в исходной реплике", "evidence_quote_mismatch"),
    ("private@example.invalid model output", "invalid_evaluation"),
])
def test_validation_reason_survives_refresh_without_storing_model_content(boundary, monkeypatch, message, expected_code):
    client, store, transport = boundary
    def invalid(*args, **kwargs):
        raise ai_evaluator.EvaluationValidationError(message, {"prompt_tokens": 9, "completion_tokens": 4})
    monkeypatch.setattr(ai_evaluator, "evaluate", invalid)
    prepared = preview(client, conversation_id="r1")
    result = client.post("/api/evaluate/r1", headers={**SUP, "X-AI-Preview": prepared["preview_id"]})
    assert result.status_code == 502
    assert result.json()["detail"] == ai_evaluator.ERROR_MESSAGES[expected_code]
    detail = client.get("/api/conversations/r1").json()
    assert detail["status"] == "Error" and detail["evaluation"] is None
    assert detail["evaluation_error"]["code"] == expected_code
    assert detail["evaluation_error"]["message"] == result.json()["detail"]
    assert store.data["budget"]["attempts"] == 1 and store.data["budget"]["completion_tokens"] == 4
    assert "private@example.invalid" not in json.dumps(store.data)
    assert store.data["audit"][-1]["error_code"] == expected_code


def test_successful_retry_clears_persistent_error_detail(boundary, monkeypatch):
    client, store, transport = boundary
    from backend.main import digest
    store.data.setdefault("evaluation_errors", {})["r1"] = {"transcript_hash": digest(store.data["records"]["r1"]),
        "error_type": "EvaluationValidationError", "error_code": "evidence_quote_mismatch"}
    assert client.get("/api/conversations/r1").json()["evaluation_error"] is not None
    evaluate(client)
    assert client.get("/api/conversations/r1").json()["evaluation_error"] is None


def test_manual_review_is_visible_but_never_counted_as_an_evaluation(boundary, monkeypatch):
    client, store, transport = boundary
    monkeypatch.setattr(ai_evaluator, "evaluate", require_review)
    prepared = preview(client, conversation_id="r1")
    result = client.post("/api/evaluate/r1", headers={**SUP, "X-AI-Preview": prepared["preview_id"]})
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "Review" and result.json()["evaluation"] is None
    assert "r1" not in store.data["evaluations"] and not store.active
    assert store.data["budget"]["attempts"] == 1
    assert store.data["budget"]["prompt_tokens"] == 7
    detail = client.get("/api/conversations/r1").json()
    assert detail["status"] == "Review" and detail["manual_review"]["code"] == "insufficient_evidence"
    result = client.post("/api/assistant/filter", headers=SUP, json={"filters": {"status": "Review"}}).json()
    assert result["total"] == 1 and result["items"][0]["conversation_id"] == "r1"
    assert result["coverage"]["evaluated"] == 0 and result["coverage"]["total"] == 2
    assert result["coverage"]["statuses"]["Review"] == 1
    assert result["items"][0]["score"] is None
    assert not transport["calls"]


def test_manual_review_on_retry_preserves_previous_result_without_using_it_as_current(boundary, monkeypatch):
    client, store, transport = boundary
    old = evaluate(client)
    monkeypatch.setattr(ai_evaluator, "evaluate", require_review)
    prepared = preview(client, conversation_id="r1", force=True)
    result = client.post("/api/evaluate/r1?force=true", headers={**SUP, "X-AI-Preview": prepared["preview_id"]})
    assert result.status_code == 200 and result.json()["status"] == "Review"
    assert result.json()["evaluation"] == old == store.data["evaluations"]["r1"]
    detail = client.get("/api/conversations/r1").json()
    assert detail["evaluation"]["final_score"] == old["final_score"]
    assert not detail["coaching"]
    assert client.post("/api/appeals/submit", headers=OP, json={
        "conversation_id": "r1", "criterion_id": "07", "evaluation_id": old["id"], "comment": "Проверить"}).status_code == 409
    filtered = client.post("/api/assistant/filter", headers=SUP, json={"filters": {}}).json()
    assert filtered["coverage"]["evaluated"] == 0
    assert next(row for row in filtered["items"] if row["conversation_id"] == "r1")["score"] is None


def test_batch_continues_past_manual_review_and_later_retry_clears_it(boundary, monkeypatch):
    client, store, transport = boundary
    original = ai_evaluator.evaluate
    def mixed(record, criteria):
        return require_review() if record["conversation_id"] == "r1" else original(record, criteria)
    monkeypatch.setattr(ai_evaluator, "evaluate", mixed)
    prepared = preview(client, "batch", conversation_ids=["r1", "k1"])
    response = client.post("/api/evaluate-batch", headers={**SUP, "X-AI-Preview": prepared["preview_id"]},
                           json={"conversation_ids": ["r1", "k1"]})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["completed"] == [{"id": "k1", "cached": False}]
    assert [row["id"] for row in result["reviews"]] == ["r1"] and "error" not in result
    assert store.status("r1") == "Review" and store.status("k1") == "Evaluated"
    monkeypatch.setattr(ai_evaluator, "evaluate", original)
    evaluate(client, "r1")
    assert store.status("r1") == "Evaluated" and "r1" not in store.data["evaluation_errors"]
    assert store.data["budget"]["attempts"] == 3 and len(transport["calls"]) == 2

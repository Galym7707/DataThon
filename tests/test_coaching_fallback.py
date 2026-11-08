"""Valid scoring survives missing optional coaching; transport is always fake."""
import pytest

from backend.coaching import GENERIC_GUIDANCE, RULE_GUIDANCE
from backend.main import digest
from tests.test_ai_requests import boundary, evaluate, preview, SUP, OP


@pytest.mark.parametrize("recommendation,task", [
    ("", ""), ("Совет", ""), ("", "Задание"), (" \n ", "Задание"),
    ("x" * 701, "Задание"), ("Совет", "x" * 701),
])
def test_valid_score_is_saved_and_missing_coaching_uses_local_rule(boundary, recommendation, task):
    client, store, transport = boundary
    store.data.setdefault("evaluation_errors", {})["r1"] = {
        "transcript_hash": digest(store.data["records"]["r1"]),
        "error_type": "EvaluationValidationError", "error_code": "missing_recommendation"}
    transport["evaluation_patch"] = {"07": {"recommendation": recommendation, "practice_task": task}}
    result = evaluate(client)
    assert result["final_score"] == 95 and result["has_gross_violation"] is True
    closure = next(r for r in result["results"] if r["criterion_id"] == "07")
    assert closure["value"] == 0 and closure["recommendation"] == closure["practice_task"] == ""
    assert closure["proof_quote"] == store.data["records"]["r1"]["transcript"][1]["text"]
    detail = client.get("/api/conversations/r1").json()
    assert detail["status"] == "Evaluated" and detail["evaluation_error"] is None
    guidance = next(r for r in detail["coaching"] if r["criterion_id"] == "07")
    assert guidance["source"] == "rule"
    assert (guidance["recommendation"], guidance["task"]) == RULE_GUIDANCE["07"]
    exercise = client.get("/api/practice/r1/07", headers=OP).json()
    assert exercise["source"] == "rule" and exercise["task"] == guidance["task"]
    assert store.data["budget"]["attempts"] == 1 and len(transport["calls"]) == 1


def test_complete_model_coaching_is_preserved(boundary):
    client, store, transport = boundary
    transport["evaluation_patch"] = {"07": {"recommendation": " Предложите помощь и попрощайтесь. ",
                                              "practice_task": " Завершите разговор. "}}
    evaluate(client)
    item = next(r for r in client.get("/api/conversations/r1").json()["coaching"] if r["criterion_id"] == "07")
    assert item["source"] == "ai" and item["recommendation"] == "Предложите помощь и попрощайтесь."
    assert item["task"] == "Завершите разговор."


@pytest.mark.parametrize("cid,value", [("07", True), ("03", None), ("08", False)])
def test_passed_na_and_absent_violation_never_receive_coaching(boundary, cid, value):
    client, store, transport = boundary
    transport["evaluation_patch"] = {cid: {"value": value, "recommendation": "Лишний совет", "practice_task": "Лишнее задание"}}
    result = evaluate(client)
    row = next(r for r in result["results"] if r["criterion_id"] == cid)
    assert row["recommendation"] == row["practice_task"] == ""
    assert not any(r["criterion_id"] == cid for r in client.get("/api/conversations/r1").json()["coaching"])


def test_custom_rule_fallback_does_not_inherit_standard_closure_advice(boundary):
    client, store, transport = boundary
    custom = next(c for c in store.data["checklist"]["criteria"] if c["id"] == "07")
    custom["description"] = "Спросите, удобно ли продолжить завтра."
    transport["evaluation_patch"] = {"07": {"recommendation": "", "practice_task": ""}}
    evaluate(client)
    exercise = client.get("/api/practice/r1/07", headers=OP).json()
    assert exercise["criterion"]["description"] == custom["description"]
    assert (exercise["recommendation"], exercise["task"]) == GENERIC_GUIDANCE


def test_missing_coaching_does_not_relax_evidence_validation(boundary):
    client, store, transport = boundary
    transport["evaluation_patch"] = {"07": {"recommendation": "", "practice_task": "", "proof_turn": 99}}
    p = preview(client, conversation_id="r1")
    response = client.post("/api/evaluate/r1", headers={**SUP, "X-AI-Preview": p["preview_id"]})
    assert response.status_code == 502 and "r1" not in store.data["evaluations"]
    assert client.get("/api/conversations/r1").json()["evaluation_error"]["code"] == "invalid_evidence_turns"


def test_batch_and_repeat_use_rule_fallback_without_additional_calls(boundary):
    client, store, transport = boundary
    transport["evaluation_patch"] = {"07": {"recommendation": "", "practice_task": ""}}
    p = preview(client, "batch", conversation_ids=["r1", "k1"])
    response = client.post("/api/evaluate-batch", headers={**SUP, "X-AI-Preview": p["preview_id"]},
                           json={"conversation_ids": ["r1", "k1"]})
    assert response.status_code == 200 and len(response.json()["completed"]) == 2
    previous = store.data["evaluations"]["r1"]
    repeated = evaluate(client, force=True)
    assert repeated["id"] != previous["id"] and repeated["final_score"] == previous["final_score"]
    assert previous in store.data["history"]["r1"]
    assert len(transport["calls"]) == store.data["budget"]["attempts"] == 3

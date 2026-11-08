"""Long-call regression and safe provider failures, with no real API calls."""
import copy
import json
from types import SimpleNamespace

import httpx
import pytest
from jsonschema import Draft202012Validator, ValidationError
from openai import BadRequestError

from backend import ai_evaluator, ai_gateway
from backend.scoring_engine import default_checklist
from tests.test_ai_requests import boundary, evaluate, preview, SUP


def enum_count(node):
    if isinstance(node, dict):
        return len(node.get("enum", [])) + sum(enum_count(value) for key, value in node.items() if key != "enum")
    if isinstance(node, list):
        return sum(map(enum_count, node))
    return 0


def transcript(size):
    return [{"id": f"m{i + 1}", "speaker": "operator" if i % 2 else "client",
             "timestamp": f"{i // 60:02}:{i % 60:02}",
             "text": "Здравствуйте, меня зовут Алина. Чем помочь?" if i % 2 else "Подскажите, где открыть раздел?"}
            for i in range(size)]


@pytest.mark.parametrize("size", [45, 65, 66, 73, 75, 78, 115, 2000])
def test_schema_remains_within_provider_limits_for_long_calls(size):
    schema = ai_evaluator.response_schema(default_checklist(), transcript(size))
    assert enum_count(schema) <= 1000
    assert enum_count(schema) == enum_count(ai_evaluator.response_schema(default_checklist(), transcript(2)))
    rows = schema["properties"]["results"]["anyOf"][0]["properties"]
    assert rows["contact"]["properties"]["proof_turn"]["enum"] == [2]
    for row in rows.values():
        items = row["properties"]["evidence_turns"]["items"]
        Draft202012Validator(items).validate(size)
        for invalid in (0, size + 1, -1, True, "1", 1.5):
            with pytest.raises(ValidationError):
                Draft202012Validator(items).validate(invalid)


def test_long_call_previews_and_batch_preserve_all_turns_and_exact_evidence(boundary, monkeypatch):
    client, store, transport = boundary
    for cid, size in (("r1", 78), ("k1", 115)):
        store.data["records"][cid].update(channel="voice call", transcript=transcript(size))
    transport["evaluation_patch"] = {"01": {"proof_turn": 2, "evidence_turns": [2]}}
    factory = ai_evaluator.OpenAI
    def checked_factory(**options):
        fake = factory(**options)
        create = fake.chat.completions.create
        def checked_create(**request):
            assert enum_count(request["response_format"]["json_schema"]["schema"]) <= 1000
            return create(**request)
        fake.chat.completions.create = checked_create
        return fake
    monkeypatch.setattr(ai_evaluator, "OpenAI", checked_factory)
    p = preview(client, "batch", conversation_ids=["r1", "k1"])
    assert [len(json.loads(r["request"]["messages"][1]["content"])["transcript"]) for r in p["requests"]] == [78, 115]
    result = client.post("/api/evaluate-batch", headers={**SUP, "X-AI-Preview": p["preview_id"]},
                         json={"conversation_ids": ["r1", "k1"]})
    assert result.status_code == 200 and len(result.json()["completed"]) == 2
    assert transport["calls"] == [r["request"] for r in p["requests"]]
    for cid, size in (("r1", 78), ("k1", 115)):
        detail = client.get(f"/api/conversations/{cid}").json()
        assert detail["status"] == "Evaluated" and len(detail["transcript"]) == size
        rows = detail["evaluation"]["results"]
        contact = next(r for r in rows if r["criterion_id"] == "01")
        assert contact["proof_message_index"] == 1 and contact["proof_message_id"] == "m2"
        closure = next(r for r in rows if r["criterion_id"] == "07")
        assert closure["proof_message_index"] == size - 1 and closure["proof_message_id"] == f"m{size}"
        assert closure["proof_quote"] in detail["transcript"][-1]["text"]
    evaluate(client, "r1", force=True)
    assert store.data["budget"]["attempts"] == len(transport["calls"]) == 3


def test_oversized_user_checklist_is_rejected_before_transport_or_budget_reservation(boundary):
    client, store, transport = boundary
    scale = copy.deepcopy(default_checklist()[3])
    store.data["checklist"]["criteria"] = [{**scale, "id": f"criterion{i}", "levels": list(range(50)), "max_scale": 49} for i in range(30)]
    response = client.post("/api/ai/prepare", headers=SUP, json={"purpose": "evaluation", "conversation_id": "r1"})
    assert response.status_code == 422 and transport["calls"] == []
    assert store.data["budget"]["attempts"] == 0


def test_global_enum_ceiling_is_checked_inclusively():
    ai_gateway.validate_schema_limits({"anyOf": [{"enum": list(range(500))}, {"enum": list(range(500))}]})
    with pytest.raises(ai_gateway.PrivacyError):
        ai_gateway.validate_schema_limits({"anyOf": [{"enum": list(range(500))}, {"enum": list(range(501))}]})


def test_bad_provider_parameters_are_not_reported_as_connection_failure(boundary, monkeypatch):
    client, store, transport = boundary
    private = "private-secret@example.invalid"
    def factory(**options):
        assert options["max_retries"] == 0
        def create(**request):
            transport["calls"].append(request)
            raise BadRequestError(private, response=httpx.Response(400,
                request=httpx.Request("POST", "https://api.openai.com/v1/chat/completions")),
                body={"message": private, "code": "invalid_json_schema"})
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    monkeypatch.setattr(ai_evaluator, "OpenAI", factory)
    p = preview(client, conversation_id="r1")
    response = client.post("/api/evaluate/r1", headers={**SUP, "X-AI-Preview": p["preview_id"]})
    assert response.status_code == 502
    assert response.json()["detail"] == ai_evaluator.ERROR_MESSAGES["provider_request_error"]
    assert private not in response.text and private not in json.dumps(store.data)
    detail = client.get("/api/conversations/r1").json()
    assert detail["evaluation_error"]["code"] == "provider_request_error"
    assert store.data["audit"][-1]["error_code"] == "provider_request_error"
    assert len(transport["calls"]) == store.data["budget"]["attempts"] == 1

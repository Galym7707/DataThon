"""Optional assistant ceilings retain shared budget and privacy enforcement."""
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.manager_assistant import DEFAULT_FILTERS

SUPERVISOR = {"X-Role": "supervisor"}


@pytest.fixture
def unlimited_client(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-no-network")
    monkeypatch.setenv("OPENAI_MAX_CALLS", "unlimited")
    monkeypatch.setenv("OPENAI_ASSISTANT_MAX_CALLS", "unlimited")
    monkeypatch.delenv("QA_SUPERVISOR_TOKEN", raising=False)
    dataset = tmp_path / "dataset.json"
    dataset.write_text(json.dumps({"isSuccess": True, "data": {"dataset_group_id": "DEV", "records": [{
        "conversation_id": "synthetic-1", "language": "RU", "channel": "agent chat", "audio_url": None,
        "transcript": [{"speaker": "client", "text": "Синтетический вопрос", "timestamp": "00:00"},
                       {"speaker": "operator", "text": "Здравствуйте", "timestamp": "00:02"}]}]}}), encoding="utf-8")
    from backend.main import create_app
    app = create_app(tmp_path / "store.json", dataset)
    captured = []
    def mock_dispatch(prepared, current_policy=None):
        captured.append(prepared)
        if callable(current_policy):
            current_policy()
        payload = {"kind": "search", "operation": "merge", "clear_fields": [],
                   "filters": {key: None for key in DEFAULT_FILTERS}, "clarification": None}
        return SimpleNamespace(usage=SimpleNamespace(prompt_tokens=5, completion_tokens=7), choices=[
            SimpleNamespace(finish_reason="stop", message=SimpleNamespace(refusal=None, content=json.dumps(payload)))])
    monkeypatch.setattr("backend.ai_gateway.dispatch", mock_dispatch)
    with TestClient(app) as client:
        yield client, captured


def prepare(client, headers=SUPERVISOR):
    return client.post("/api/ai/prepare", headers=headers,
                       json={"purpose": "assistant_search", "query": "Покажи диалоги"})


def test_unlimited_allows_more_than_twenty_and_preserves_usage(unlimited_client):
    client, captured = unlimited_client
    store = client.app.state.store
    store.data["assistant_budget"] = {"attempts": 25}
    store.save()
    preview = prepare(client)
    assert preview.status_code == 200
    response = client.post("/api/assistant", headers=SUPERVISOR, json={"preview_id": preview.json()["preview_id"]})
    assert response.status_code == 200
    budget = response.json()["assistant_budget"]
    assert budget["attempts"] == 26 and budget["unlimited"] is True
    assert budget["limit"] is None and budget["remaining"] is None
    assert response.json()["budget"]["attempts"] == 1
    assert response.json()["budget"]["prompt_tokens"] == 5
    assert response.json()["budget"]["completion_tokens"] == 7
    assert len(captured) == 1
    assert client.get("/api/health").json()["assistant_budget"] == budget


@pytest.mark.parametrize("limit,attempts", [("0", 0), ("2", 2), ("2", 99)])
def test_numeric_and_zero_assistant_limits_remain_available(unlimited_client, monkeypatch, limit, attempts):
    client, captured = unlimited_client
    monkeypatch.setenv("OPENAI_ASSISTANT_MAX_CALLS", limit)
    store = client.app.state.store
    store.data["assistant_budget"] = {"attempts": attempts}
    store.save()
    assert prepare(client).status_code == 429
    budget = client.get("/api/health").json()["assistant_budget"]
    assert budget["remaining"] == 0 and budget["unlimited"] is False
    assert budget["limit"] == int(limit) and budget["attempts"] == attempts
    assert captured == []


def test_unlimited_assistant_still_respects_numeric_shared_budget(unlimited_client, monkeypatch):
    client, captured = unlimited_client
    monkeypatch.setenv("OPENAI_MAX_CALLS", "3")
    client.app.state.store.data["budget"]["attempts"] = 3
    client.app.state.store.save()
    assert prepare(client).status_code == 429
    assert captured == []


def test_unlimited_never_bypasses_role_preview_or_global_block(unlimited_client):
    client, captured = unlimited_client
    assert prepare(client, {"X-Role": "operator"}).status_code == 403
    missing = client.post("/api/assistant", headers=SUPERVISOR, json={"preview_id": "missing-" * 5})
    assert missing.status_code == 409
    assert client.post("/api/ai/privacy", headers=SUPERVISOR,
                       json={"mask_personal_data": True, "block_external_ai": True}).status_code == 200
    assert prepare(client).status_code == 403
    assert captured == []

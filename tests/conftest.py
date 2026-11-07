"""Ordinary tests must never reach the paid model API."""
import pytest


@pytest.fixture(autouse=True)
def prohibit_paid_api(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-placeholder")

    def blocked(*args, **kwargs):
        raise AssertionError("Paid OpenAI calls are disabled in ordinary tests")

    monkeypatch.setattr("openai.resources.chat.completions.Completions.create", blocked)

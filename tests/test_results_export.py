"""Submission interoperability: types, original turns, coverage and stale policies."""
import copy
import json
from pathlib import Path

import pytest
from jsonschema import ValidationError

from backend.ai_evaluator import policy_signature
from backend.results_export import build_submission, checklist_digest, digest, validate_submission
from backend.scoring_engine import default_checklist, score_evaluation


@pytest.fixture
def export_case():
    records = [{"conversation_id": "export-1", "language": "RU", "channel": "agent chat",
                "audio_url": None, "transcript": [
                    {"speaker": "bot", "timestamp": "00:00", "text": "Бот"},
                    {"speaker": "client", "timestamp": "00:01", "text": "Вопрос"},
                    {"speaker": "operator", "timestamp": "00:02", "text": "Здравствуйте!"}]}]
    checklist = {"version": 1, "criteria": default_checklist()}
    results = [{"criterion_id": c["id"], "value": 0 if c["type"] == "flag" else c["max_scale"],
                "is_na": False, "reason": "Тестовый результат", "proof_quote": "Здравствуйте!",
                "proof_message_index": 2, "proof_timestamp": "00:02"} for c in checklist["criteria"]]
    results[1].update(value=None, is_na=True)
    results[2].update(value=None, is_na=True)
    results[5]["value"] = 7
    evaluation = {**score_evaluation(checklist["criteria"], results), "results": results,
                  "source": "openai", "model": "mock-model", "policy_signature": policy_signature(),
                  "semantic_hash": checklist_digest(checklist["criteria"]), "transcript_hash": digest(records[0])}
    return records, checklist, {"export-1": evaluation}


def export(case):
    return build_submission(*case, "TEST TEAM", policy_signature(), "mock-model")


def schema():
    return json.loads((Path(__file__).resolve().parents[1] / "results/schema.json").read_text(encoding="utf-8"))


def test_export_preserves_types_turn_numbers_and_weighted_score(export_case):
    submission = export(export_case)
    validate_submission(submission, export_case[0], schema())
    row = submission["results"][0]
    values = {c["criterion_id"]: c["value"] for c in row["criteria"]}
    assert type(values["contact"]) is bool and values["contact"] is True
    assert values["discovery"] is None and values["identification"] is None
    assert type(values["dialogue"]) is int and values["dialogue"] == 7
    assert values["critical"] is False
    assert all(c["evidence_turns"] == [3] for c in row["criteria"])
    assert row["score"]["final_score"] == 93.08  # (10 + 20 + 15 + 10.5 + 5) / 65 * 100


@pytest.mark.parametrize("field", ["policy_signature", "semantic_hash", "transcript_hash"])
def test_stale_assessment_is_error_not_a_fabricated_zero(export_case, field):
    export_case[2]["export-1"][field] = "old"
    row = export(export_case)["results"][0]
    assert row["status"] == "error" and row["score"] is None and row["criteria"] == []


def test_export_retains_missing_ids_and_excludes_uploaded_extras(export_case):
    records, checklist, evaluations = export_case
    records.append({**copy.deepcopy(records[0]), "conversation_id": "missing"})
    evaluations["uploaded-extra"] = copy.deepcopy(evaluations["export-1"])
    submission = export(export_case)
    assert [r["conversation_id"] for r in submission["results"]] == ["export-1", "missing"]
    assert submission["results"][1]["status"] == "error"
    validate_submission(submission, records, schema())


def test_submission_rejects_duplicate_criteria_and_out_of_range_evidence(export_case):
    submission = export(export_case)
    duplicate = copy.deepcopy(submission)
    duplicate["results"][0]["criteria"][1] = duplicate["results"][0]["criteria"][0]
    with pytest.raises(ValueError, match="критериев"):
        validate_submission(duplicate, export_case[0], schema())
    submission["results"][0]["criteria"][0]["evidence_turns"] = [4]
    with pytest.raises(ValueError, match="транскрипта"):
        validate_submission(submission, export_case[0], schema())


def test_contact_na_is_only_exported_for_voice_recording(export_case):
    records, checklist, evaluations = export_case
    evaluations["export-1"]["results"][0].update(value=None, is_na=True)
    assert export(export_case)["results"][0]["status"] == "error"
    records[0]["channel"] = "voice call"
    evaluations["export-1"]["transcript_hash"] = digest(records[0])
    submission = export(export_case)
    assert submission["results"][0]["criteria"][0]["value"] is None
    validate_submission(submission, records, schema())


def test_schema_rejects_numeric_boolean_and_critical_mismatch(export_case):
    submission = export(export_case)
    numeric = copy.deepcopy(submission)
    numeric["results"][0]["criteria"][0]["value"] = 1
    with pytest.raises(ValidationError):
        validate_submission(numeric, export_case[0], schema())
    submission["results"][0]["score"]["critical_flag"] = True
    with pytest.raises(ValueError, match="critical_flag"):
        validate_submission(submission, export_case[0], schema())

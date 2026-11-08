"""Assistant search and recommendations use synthetic data; no model calls."""
import copy
import json

import pytest

from backend.manager_assistant import (
    DEFAULT_FILTERS, assistant_settings, build_recommendation_request,
    build_search_request, execute_search, normalize_filters,
    parse_recommendation_response, parse_search_response, search_schema, summarize_issues,
)
from backend.scoring_engine import default_checklist, score_evaluation


def model_command(**patch):
    return {"kind": "search", "operation": "merge", "clear_fields": [],
            "filters": {key: patch.get(key) for key in DEFAULT_FILTERS}, "clarification": None}


def result_set(criteria):
    return [{"criterion_id": c["id"], "value": 0 if c["type"] == "flag" else c["max_scale"],
             "is_na": False, "reason": "Правило соблюдено", "proof_quote": "Добрый день",
             "proof_timestamp": "00:02", "proof_message_index": 1}
            for c in criteria]


@pytest.fixture
def synthetic():
    criteria = default_checklist()
    records = {}
    for cid, language, status in [("a", "RU", "Evaluated"), ("b", "KZ", "Evaluated"),
                                  ("c", "EN", "Evaluated"), ("d", "RU", "Pending"),
                                  ("e", "KZ", "Stale"), ("f", "EN", "Error"), ("g", "RU", "Evaluating")]:
        records[cid] = {"conversation_id": cid, "language": language, "channel": "agent chat",
                        "transcript": [{"text": "Клиент Секретов, ИИН 123456789012", "timestamp": "00:00", "speaker": "client"},
                                       {"text": "Добрый день", "timestamp": "00:02", "speaker": "operator", "id": f"{cid}-message"}]}
    evaluations = {}
    for cid in ("a", "b", "c", "e"):
        results = result_set(criteria)
        if cid in ("a", "b", "e"):
            results[0].update(value=0, reason="Оператор не представился")
            results[-1].update(value=1, reason="Сохранено обоснование грубой ошибки")
        if cid == "a":
            results[2].update(value=None, is_na=True, reason="Идентификация не требуется")
            results[3].update(value=0, reason="Вопрос не закрыт")
            results[4].update(value=0, reason="Нет реакции на проблему")
            results[5].update(value=0, reason="Непонятный порядок действий")
        evaluations[cid] = {"id": f"eval-{cid}", "results": results, **score_evaluation(criteria, results)}
    before_b = copy.deepcopy(evaluations["b"])
    # Final appeal removes both previously failing criteria; original history retained.
    evaluations["b"]["results"][0].update(value=1, override_comment="Представление подтверждено", overridden_at="now")
    evaluations["b"]["results"][-1].update(value=0, override_comment="Нарушение не подтвердилось", overridden_at="now")
    evaluations["b"].update(score_evaluation(criteria, evaluations["b"]["results"]))
    data = {"dataset_group_id": "DEV", "records": records, "evaluations": evaluations,
            "checklist": {"version": 1, "criteria": criteria}, "history": {"b": [before_b]},
            "appeals": [{"id": "appeal-a", "conversation_id": "a", "criterion_id": "01", "status": "PENDING", "evaluation_id": "eval-a"},
                        {"id": "appeal-old", "conversation_id": "b", "criterion_id": "08", "status": "APPROVED", "evaluation_id": "eval-b"}]}
    statuses = dict(zip(records, ("Evaluated", "Evaluated", "Evaluated", "Pending", "Stale", "Error", "Evaluating")))
    return data, statuses


def test_search_request_contains_no_records_scores_history_or_credentials(synthetic, monkeypatch):
    data, _ = synthetic
    monkeypatch.setenv("OPENAI_API_KEY", "never-send-this")
    request = build_search_request("Только на казахском", {"gross_only": True}, data["checklist"]["criteria"])
    encoded = json.dumps(request, ensure_ascii=False)
    assert "Секретов" not in encoded and "123456789012" not in encoded and "never-send-this" not in encoded
    assert set(request["payload"]) == {"query", "current_filters", "available_criteria", "response_language"}
    assert all(set(c) == {"id", "name", "type"} for c in request["payload"]["available_criteria"])
    assert request["payload"]["current_filters"]["gross_only"] is True


def test_sequential_followups_preserve_existing_search_and_sort(synthetic):
    data, statuses = synthetic
    criteria = data["checklist"]["criteria"]
    first = parse_search_response(model_command(gross_only=True), criteria, {})
    second = parse_search_response(model_command(language="RU"), criteria, first["filters"])
    third = parse_search_response(model_command(sort="score_asc"), criteria, second["filters"])
    assert third["filters"]["language"] == "RU" and third["filters"]["gross_only"]
    assert [r["conversation_id"] for r in execute_search(data, statuses, third["filters"])["items"]] == ["a"]


def test_reset_and_explicit_field_clear(synthetic):
    criteria = synthetic[0]["checklist"]["criteria"]
    current = {"language": "RU", "gross_only": True}
    clear = model_command(language="KZ"); clear["clear_fields"] = ["gross_only"]
    assert parse_search_response(clear, criteria, current)["filters"]["gross_only"] is False
    clear["operation"] = "replace"
    clear["filters"]["language"] = None
    assert parse_search_response(clear, criteria, current)["filters"] == DEFAULT_FILTERS


@pytest.mark.parametrize("status", ["Pending", "Evaluating", "Stale", "Error", "Review"])
def test_gross_search_clears_incompatible_status_without_losing_scope(synthetic, status):
    data, statuses = synthetic
    command = parse_search_response(model_command(gross_only=True), data["checklist"]["criteria"],
                                    {"status": status, "language": "RU", "channel": "agent chat"})
    assert command["filters"]["status"] is None
    result = execute_search(data, statuses, command["filters"])
    assert result["total"] == 1
    assert result["items"][0]["conversation_id"] == "a"
    assert result["filters"]["language"] == "RU" and result["filters"]["channel"] == "agent chat"
    # Old conflicting UI/history filters are canonicalized by local search too.
    old = execute_search(data, statuses, {"gross_only": True, "status": status})
    assert [row["conversation_id"] for row in old["items"]] == ["a"]


def test_explicit_unassessed_followup_replaces_gross_condition(synthetic):
    data, statuses = synthetic
    command = parse_search_response(model_command(status="Pending"), data["checklist"]["criteria"],
                                    {"gross_only": True, "language": "RU"})
    assert command["filters"]["gross_only"] is False
    assert [row["conversation_id"] for row in execute_search(data, statuses, command["filters"])["items"]] == ["d"]


@pytest.mark.parametrize("patch", [
    {"sql": "DELETE FROM evaluations"}, {"language": "xx"}, {"score_below": -1},
    {"score_above": 101}, {"score_below": True}, {"gross_only": "true"},
    {"criterion_id": "unknown", "criterion_state": "unmet"}, {"criterion_id": "01"},
    {"score_below": 20, "score_above": 50}, {"score_below": float("nan")},
])
def test_unknown_or_invalid_filters_are_rejected(patch):
    with pytest.raises(ValueError):
        normalize_filters(patch, default_checklist())


@pytest.mark.parametrize("mutation", [
    lambda c: c.update(sql="SELECT *"),
    lambda c: c["filters"].update(code="os.system('evil')"),
    lambda c: c["filters"].update(criterion_id="nonexistent", criterion_state="unmet"),
    lambda c: c["clear_fields"].append("__dict__"),
])
def test_model_cannot_smuggle_code_mutations_or_unstructured_answers(mutation):
    command = model_command()
    mutation(command)
    with pytest.raises(ValueError):
        parse_search_response(command, default_checklist(), {})


def test_clarification_leaves_filters_untouched():
    command = model_command()
    command.update(kind="clarification", clarification="Уточните, какой критерий вы имеете в виду?")
    output = parse_search_response(command, default_checklist(), {"language": "KZ"})
    assert output["kind"] == "clarification" and output["filters"]["language"] == "KZ"
    command["filters"]["language"] = "EN"
    command["operation"] = "replace"
    command["clear_fields"] = ["language"]
    output = parse_search_response(command, default_checklist(), {"language":"KZ"})
    assert output["filters"]["language"] == "KZ"  # Echoed fields cannot change a clarification's scope.
    command["filters"]["language"] = None
    command["clarification"] = "x" * 401
    with pytest.raises(ValueError):
        parse_search_response(command, default_checklist(), {})


def test_recommendation_intent_requires_separate_request():
    command = model_command(); command["kind"] = "recommendations"
    assert parse_search_response(command, default_checklist(), {})["kind"] == "recommendations"


def test_unused_free_text_cannot_be_presented_as_facts():
    command = model_command(gross_only=True)
    command["clarification"] = "Invented count: 500 errors"
    result = parse_search_response(command, default_checklist(), {})
    assert result["clarification"] is None and result["filters"]["gross_only"]


def test_frequency_summary_counts_final_applicable_results_with_evidence(synthetic):
    data, statuses = synthetic
    result = summarize_issues(data, statuses, {})
    assert result["kind"] == "summary" and result["filtered_coverage"]["evaluated"] == 3
    rows = {row["criterion_id"]: row for row in result["issues_summary"]}
    assert rows["08"]["count"] == 1 and rows["08"]["sample_size"] == 3
    assert rows["08"]["sources"][0]["evidence"]["message_id"] == "a-message"
    assert "03" not in rows  # N/A is not a failed identification.
    assert {s["conversation_id"] for row in rows.values() for s in row["sources"]} == {"a"}
    assert summarize_issues(data, statuses, {"language":"KZ"})["issues_summary"] == []  # Appeal resolved the flag.
    empty = summarize_issues(data, statuses, {"status":"Pending"})
    assert empty["filtered_coverage"]["evaluated"] == 0 and empty["issues_summary"] == []


def test_summary_intent_supports_scope_and_followups(synthetic):
    data, statuses = synthetic
    command = model_command(); command["kind"] = "summary"
    result = parse_search_response(command, data["checklist"]["criteria"], {"gross_only":True})
    assert result["kind"] == "summary" and result["filters"]["gross_only"]
    assert summarize_issues(data, statuses, result["filters"])["filtered_coverage"]["total"] == 1
    command["operation"] = "replace"
    assert parse_search_response(command, data["checklist"]["criteria"], result["filters"])["filters"] == DEFAULT_FILTERS


def test_summary_ranks_counts_and_excludes_na_from_applicable_sample(synthetic):
    data, statuses = synthetic
    for cid in ("b", "c"):
        next(r for r in data["evaluations"][cid]["results"] if r["criterion_id"]=="07").update(value=0)
    next(r for r in data["evaluations"]["c"]["results"] if r["criterion_id"]=="03").update(value=0)
    summary=summarize_issues(data,statuses,{})["issues_summary"]
    assert summary[0]["criterion_id"]=="07" and summary[0]["count"]==2
    identification=next(row for row in summary if row["criterion_id"]=="03")
    assert (identification["count"],identification["sample_size"],identification["excluded_na"])==(1,2,1)


def test_program_counts_current_evaluations_and_preserves_all_statuses(synthetic):
    data, statuses = synthetic
    result = execute_search(data, statuses, {})
    assert result["coverage"] == {"evaluated": 3, "total": 7, "statuses": {"Pending": 1, "Evaluating": 1, "Evaluated": 3, "Stale": 1, "Error": 1, "Review": 0}}
    assert result["dataset"]["synthetic"]
    rows = {r["conversation_id"]: r for r in result["items"]}
    for cid in ("d", "e", "f", "g"):
        assert rows[cid]["score"] is None and not rows[cid]["has_gross_violation"] and rows[cid]["issues"] == []
    for status, cid in (("Pending", "d"), ("Stale", "e"), ("Error", "f"), ("Evaluating", "g")):
        assert [r["conversation_id"] for r in execute_search(data, statuses, {"status": status})["items"]] == [cid]


def test_appeal_final_values_drive_scores_flags_and_criterion_results(synthetic):
    data, statuses = synthetic
    rows = {r["conversation_id"]: r for r in execute_search(data, statuses, {})["items"]}
    assert rows["b"]["score"] == 100
    assert rows["b"]["initial_ai_score"] == 90
    assert not rows["b"]["has_gross_violation"] and rows["b"]["criterion_states"]["01"] == "met"
    assert [r["conversation_id"] for r in execute_search(data, statuses, {"gross_only": True})["items"]] == ["a"]
    assert [r["conversation_id"] for r in execute_search(data, statuses, {"criterion_id": "01", "criterion_state": "unmet"})["items"]] == ["a"]


def test_manual_review_is_searchable_but_never_a_score_or_recommendation(synthetic):
    data, statuses = synthetic
    statuses["a"] = "Review"
    command = parse_search_response(model_command(status="Review"), data["checklist"]["criteria"], {})
    found = execute_search(data, statuses, command["filters"])
    assert found["total"] == 1 and found["items"][0]["conversation_id"] == "a"
    assert found["items"][0]["score"] is None and found["items"][0]["issues"] == []
    assert found["coverage"]["evaluated"] == 2 and found["coverage"]["statuses"]["Review"] == 1
    assert build_recommendation_request(data, statuses, command["filters"])["catalog"] == {}


def test_final_override_reason_and_original_ai_reason_are_distinct(synthetic):
    data, statuses = synthetic
    item = data["evaluations"]["a"]["results"][0]
    item.update(override_comment="Руководитель подтвердил отсутствие представления", overridden_at="now")
    row = execute_search(data, statuses, {"language": "RU", "status": "Evaluated"})["items"][0]
    issue = row["issues"][0]
    assert issue["source"] == "appeal"
    assert issue["reason"].startswith("Руководитель") and issue["original_ai_reason"] == "Оператор не представился"
    assert issue["evidence"]["source"] == "original_ai"
    assert row["initial_ai_score"] is None  # No matching original history: do not invent one.


def test_na_and_no_are_not_interchangeable(synthetic):
    data, statuses = synthetic
    na = execute_search(data, statuses, {"criterion_id": "03", "criterion_state": "na"})
    unmet = execute_search(data, statuses, {"criterion_id": "03", "criterion_state": "unmet"})
    assert [r["conversation_id"] for r in na["items"]] == ["a"]
    assert unmet["total"] == 0
    assert na["items"][0]["criterion_states"]["03"] == "na"


def test_score_threshold_excludes_null_and_stale_scores_and_is_strict(synthetic):
    data, statuses = synthetic
    assert [r["conversation_id"] for r in execute_search(data, statuses, {"score_below": 60})["items"]] == ["a"]
    actual = data["evaluations"]["a"]["final_score"]
    assert execute_search(data, statuses, {"score_below": actual})["total"] == 0
    assert [r["conversation_id"] for r in execute_search(data, statuses, {"sort": "score_asc"})["items"]][:3] == ["a", "b", "c"]
    assert [r["conversation_id"] for r in execute_search(data, statuses, {"sort": "score_desc"})["items"]][:3] == ["b", "c", "a"]


def test_pending_appeals_search_and_verified_message_links(synthetic):
    data, statuses = synthetic
    result = execute_search(data, statuses, {"pending_appeals": True})
    assert result["total"] == 1 and result["items"][0]["conversation_id"] == "a"
    evidence = result["items"][0]["issues"][0]["evidence"]
    assert evidence["message_id"] == "a-message" and evidence["message_index"] == 1
    assert evidence["timestamp"] == "00:02" and evidence["quote"] == "Добрый день"
    assert evidence["href"] == "#conversations?conversation=a&message=1"


@pytest.mark.parametrize("reason", ["Оператор не представился", "The agent did not introduce herself", "Оператор өзін таныстырмады"])
def test_specific_intro_search_reads_saved_reasons_in_three_languages(synthetic, reason):
    data, statuses = synthetic
    data["evaluations"]["a"]["results"][0]["reason"] = reason
    result = execute_search(data, statuses, {"issue": "operator_introduction"})
    assert [r["conversation_id"] for r in result["items"]] == ["a"]
    assert result["limitations"]


def test_intro_failure_not_inferred_from_compound_greeting_criterion(synthetic):
    data, statuses = synthetic
    data["evaluations"]["a"]["results"][0]["reason"] = "Оператор представился, но не поздоровался"
    assert execute_search(data, statuses, {"issue": "operator_introduction"})["total"] == 0


def test_recommendation_payload_contains_only_necessary_aggregates(synthetic):
    data, statuses = synthetic
    request = build_recommendation_request(data, statuses, {})
    payload = json.dumps(request["payload"], ensure_ascii=False)
    assert "Секретов" not in payload and "123456789012" not in payload
    assert "transcript" not in payload and "message_index" not in payload and "eval-a" not in payload
    assert request["payload"]["synthetic_dataset"] is True
    assert request["payload"]["coverage"]["evaluated"] == 3
    assert request["catalog"]["gross_violations"]["count"] == 1
    assert request["catalog"]["gross_violations"]["sample_size"] == 3
    assert request["catalog"]["criterion_01"]["count"] == 1  # B's final appeal is respected.
    assert request["catalog"]["appeals_01"]["count"] == 1


def test_recommendations_exclude_na_from_applicable_denominator(synthetic):
    data, statuses = synthetic
    data["evaluations"]["b"]["results"][2].update(value=0, is_na=False, reason="Идентификация не выполнена")
    request = build_recommendation_request(data, statuses, {})
    item = request["catalog"]["criterion_03"]
    assert item["count"] == 1 and item["sample_size"] == 2 and item["excluded_na"] == 1
    assert item["evaluated_sample_size"] == 3


def test_gross_recommendation_links_flag_evidence_not_unrelated_failures(synthetic):
    data, statuses = synthetic
    data["evaluations"]["a"]["results"][-1].update(proof_message_index=0, proof_timestamp="00:00", proof_quote="Клиент")
    request = build_recommendation_request(data, statuses, {})
    evidence = request["catalog"]["gross_violations"]["sources"][0]["messages"]
    assert len(evidence) == 1 and evidence[0]["message_index"] == 0


def test_priority_response_only_selects_existing_server_facts(synthetic):
    data, statuses = synthetic
    request = build_recommendation_request(data, statuses, {}, "en")
    selected = parse_recommendation_response({"selected_ids": ["gross_violations", "appeals_01"]}, request["catalog"])
    assert len(selected) == 2
    assert selected[0]["count"] == 1 and selected[0]["sample_size"] == 3
    assert selected[0]["hypothesis"] is None and selected[0]["observation"].startswith("Gross violations")
    assert selected[0]["sources"][0]["conversation_id"] == "a"
    assert "short_reasons" not in selected[0]
    selected[0]["count"] = 999
    assert request["catalog"]["gross_violations"]["count"] == 1


@pytest.mark.parametrize("payload", [
    {"selected_ids": ["invented"]}, {"selected_ids": ["gross_violations", "gross_violations"]},
    {"selected_ids": ["gross_violations"] * 4}, {"selected_ids": [], "loss": "1 million"},
    {"selected_ids": [123]}, {"selected_ids": "gross_violations"},
])
def test_unconfirmed_facts_ids_and_excess_recommendations_rejected(synthetic, payload):
    request = build_recommendation_request(*synthetic, {})
    with pytest.raises(ValueError):
        parse_recommendation_response(payload, request["catalog"])


def test_empty_sample_produces_no_recommendations(synthetic):
    request = build_recommendation_request(*synthetic, {"status": "Pending"})
    assert request["catalog"] == {}
    assert parse_recommendation_response({"selected_ids": []}, request["catalog"]) == []
    assert request["filtered_coverage"]["evaluated"] == 0


def test_data_is_not_mutated_and_final_evidence_is_reused(synthetic):
    before = copy.deepcopy(synthetic)
    execute_search(*synthetic, {"gross_only": True})
    build_recommendation_request(*synthetic, {})
    assert synthetic == before


def test_separate_model_and_limit_do_not_increase_shared_budget(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "existing-model")
    monkeypatch.setenv("OPENAI_MAX_CALLS", "3")
    monkeypatch.setenv("OPENAI_MAX_OUTPUT_TOKENS", "500")
    monkeypatch.delenv("OPENAI_ASSISTANT_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_ASSISTANT_MAX_CALLS", raising=False)
    monkeypatch.delenv("OPENAI_ASSISTANT_MAX_OUTPUT_TOKENS", raising=False)
    assert assistant_settings() == {"model": "existing-model", "limit": None, "max_tokens": 500}
    monkeypatch.setenv("OPENAI_ASSISTANT_MAX_CALLS", "0")
    monkeypatch.setenv("OPENAI_ASSISTANT_MODEL", "specific-assistant-model")
    assert assistant_settings()["limit"] == 0 and assistant_settings()["model"] == "specific-assistant-model"
    import os
    assert os.environ["OPENAI_MAX_CALLS"] == "3"
    monkeypatch.setenv("OPENAI_ASSISTANT_MAX_CALLS", " UNLIMITED ")
    assert assistant_settings()["limit"] is None
    monkeypatch.setenv("OPENAI_ASSISTANT_MAX_CALLS", "20")
    assert assistant_settings()["limit"] == 20


@pytest.mark.parametrize("setting", ["-1", "", "none", "1.5", "NaN", "Infinity"])
def test_invalid_assistant_limits_fail_closed(monkeypatch, setting):
    monkeypatch.setenv("OPENAI_ASSISTANT_MAX_CALLS", setting)
    with pytest.raises(ValueError):
        assistant_settings()

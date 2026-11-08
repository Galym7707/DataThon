"""Organizer JSON 1.0 export. No model calls and no access to signed dataset URLs."""
import hashlib
import json

from .ai_evaluator import validate_evidence
from .scoring_engine import Criterion, score_evaluation


CRITERION_CODES = {
    "01": "contact", "02": "discovery", "03": "identification",
    "04": "consultation", "05": "empathy", "06": "dialogue",
    "07": "closure", "08": "critical",
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def checklist_digest(criteria):
    normalized = [Criterion(**c).model_dump() for c in criteria]
    return digest([{k: v for k, v in c.items() if k != "weight"} for c in normalized])


def build_submission(records, checklist, evaluations, team_name, policy_signature, model_name):
    """Keep dataset order and IDs, including explicit errors for missing/stale results."""
    if not team_name.strip():
        raise ValueError("Укажите название команды")
    criteria = checklist["criteria"]
    if len(criteria) != 8 or {c["id"] for c in criteria} != set(CRITERION_CODES):
        raise ValueError("Для сдачи нужны ровно восемь исходных критериев 01–08")
    ids = [r["conversation_id"] for r in records]
    if len(ids) != len(set(ids)):
        raise ValueError("Повторяющиеся ID исходного набора")
    semantics = checklist_digest(criteria)
    output = []
    models = set()
    for record in records:
        cid = record["conversation_id"]
        evaluation = evaluations.get(cid)
        try:
            if not evaluation:
                raise ValueError("Нет сохранённой оценки модели")
            if (evaluation.get("semantic_hash") != semantics
                    or evaluation.get("transcript_hash") != digest(record)
                    or evaluation.get("policy_signature") != policy_signature):
                raise ValueError("Оценка устарела: изменились правила, модель, промпт или транскрипт")
            if evaluation.get("source") != "openai" or not evaluation.get("model"):
                raise ValueError("Нет подтверждённого результата используемой модели")
            results = evaluation["results"]
            validate_evidence(results, criteria, record["transcript"])
            scored = score_evaluation(criteria, results)
            by_id = {r["criterion_id"]: r for r in results}
            exported = []
            for internal_id, code in CRITERION_CODES.items():
                result = by_id[internal_id]
                if internal_id == "01" and result["is_na"] and record["channel"] != "voice call":
                    raise ValueError("N/A для contact разрешён только для звонка с отсутствующим началом")
                value = result["value"]
                if value is not None:
                    value = int(value) if code in ("consultation", "dialogue") else bool(value)
                exported.append({"criterion_id": code, "value": value,
                                 "rationale": result.get("override_comment") or result["reason"],
                                 "evidence_turns": [result["proof_message_index"] + 1]})
            output.append({"conversation_id": cid, "status": "ok", "criteria": exported,
                           "score": {"final_score": scored["final_score"],
                                     "critical_flag": scored["has_gross_violation"]}})
            models.add(evaluation["model"])
        except (ValueError, KeyError, TypeError) as exc:
            # Only our validation errors are included; never dump provider responses/store data.
            error = str(exc) if isinstance(exc, ValueError) else "Некорректная сохранённая оценка"
            output.append({"conversation_id": cid, "status": "error", "criteria": [],
                           "score": None, "error": error})
    return {"schema_version": "1.0", "team_name": team_name.strip(),
            "model": {"mode": "external_api", "name": ", ".join(sorted(models)) or model_name},
            "results": output}


def validate_submission(submission, records, schema):
    """Validate the published schema plus dataset-dependent evidence and coverage."""
    from jsonschema import Draft202012Validator
    Draft202012Validator(schema).validate(submission)
    originals = {r["conversation_id"]: r for r in records}
    ids = [r["conversation_id"] for r in submission["results"]]
    if len(ids) != len(set(ids)) or set(ids) != set(originals):
        raise ValueError("Экспорт должен содержать каждый исходный ID ровно один раз")
    for row in submission["results"]:
        if row["status"] == "error":
            continue
        if {c["criterion_id"] for c in row["criteria"]} != set(CRITERION_CODES.values()):
            raise ValueError("Неполный или повторяющийся набор критериев")
        original = originals[row["conversation_id"]]
        for criterion in row["criteria"]:
            if criterion["criterion_id"] == "contact" and criterion["value"] is None and original["channel"] != "voice call":
                raise ValueError("N/A contact недопустим для чата")
            if any(not 1 <= i <= len(original["transcript"]) for i in criterion["evidence_turns"]):
                raise ValueError("Номер доказательства вне исходного транскрипта")
        critical = next(c["value"] for c in row["criteria"] if c["criterion_id"] == "critical")
        if row["score"]["critical_flag"] is not critical:
            raise ValueError("critical_flag не совпадает с critical.value")

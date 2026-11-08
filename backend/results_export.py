"""Organizer JSON 1.0 export. No model calls and no access to signed dataset URLs."""
import hashlib
import json

from .ai_evaluator import validate_evidence
from .ai_gateway import LocalMasker
from .scoring_engine import Criterion, default_checklist, score_evaluation


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


class SubmissionError(ValueError):
    """Controlled explanation containing no source text or provider response."""


def build_submission(records, checklist, evaluations, team_name, policy_version, model_name,
                     evaluation_errors=None):
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
                raise SubmissionError("Нет сохранённой оценки модели")
            if (evaluation.get("semantic_hash") != semantics
                    or evaluation.get("transcript_hash") != digest(record)
                    or evaluation.get("policy_version") != policy_version):
                raise SubmissionError("Оценка устарела: изменились правила или транскрипт")
            failure = (evaluation_errors or {}).get(cid, {})
            if (failure.get("manual_review") and failure.get("transcript_hash") == digest(record)
                    and failure.get("semantic_hash") == semantics and failure.get("policy_version") == policy_version):
                raise SubmissionError("Диалог ожидает ручного разбора")
            if evaluation.get("source") != "openai" or not evaluation.get("model"):
                raise SubmissionError("Нет подтверждённого результата используемой модели")
            results = evaluation["results"]
            validate_evidence(results, criteria, record["transcript"])
            scored = score_evaluation(criteria, results)
            by_id = {r["criterion_id"]: r for r in results}
            # Discover locally in the original messages as well: a supervisor's
            # appeal comment may contain details absent from the masked AI answer.
            masker = LocalMasker()
            for message in record["transcript"]:
                masker.discover(message["text"], role=message["speaker"])
            for result in results:
                masker.discover(result.get("override_comment") or result["reason"])
            exported = []
            for internal_id, code in CRITERION_CODES.items():
                result = by_id[internal_id]
                if code in ("contact", "empathy", "dialogue", "critical") and result["is_na"]:
                    raise SubmissionError("N/A запрещён для этого критерия форматом сдачи")
                turns = result.get("evidence_turns")
                if (not isinstance(turns, list) or not turns
                        or any(type(turn) is not int or not 1 <= turn <= len(record["transcript"]) for turn in turns)
                        or len(set(turns)) != len(turns) or result["proof_message_index"] + 1 not in turns):
                    raise SubmissionError("Некорректные ссылки на исходные реплики")
                value = result["value"]
                if value is not None:
                    value = int(value) if code in ("consultation", "dialogue") else bool(value)
                exported.append({"criterion_id": code, "value": value,
                                 "rationale": masker.mask(result.get("override_comment") or result["reason"], (code,)),
                                 "evidence_turns": list(turns)})
            output.append({"conversation_id": cid, "status": "ok", "criteria": exported,
                           "score": {"final_score": scored["final_score"],
                                     "critical_flag": scored["has_gross_violation"]}})
            models.add(evaluation["model"])
        except (ValueError, KeyError, TypeError) as exc:
            # Only our validation errors are included; never dump provider responses/store data.
            error = str(exc) if isinstance(exc, SubmissionError) else "Некорректная сохранённая оценка или доказательства"
            output.append({"conversation_id": cid, "status": "error", "criteria": [],
                           "score": None, "error": error})
    return {"schema_version": "1.0", "team_name": team_name.strip(),
            "model": {"mode": "external_api", "name": ", ".join(sorted(models)) or model_name},
            "results": output}


def validate_submission(submission, records, schema, criteria=None):
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
            if any(not 1 <= i <= len(original["transcript"]) for i in criterion["evidence_turns"]):
                raise ValueError("Номер доказательства вне исходного транскрипта")
        critical = next(c["value"] for c in row["criteria"] if c["criterion_id"] == "critical")
        if row["score"]["critical_flag"] is not critical:
            raise ValueError("critical_flag не совпадает с critical.value")
        reverse = {code: internal_id for internal_id, code in CRITERION_CODES.items()}
        scores = [{"criterion_id": reverse[c["criterion_id"]],
                   "value": int(c["value"]) if type(c["value"]) is bool else c["value"],
                   "is_na": c["value"] is None} for c in row["criteria"]]
        calculated = score_evaluation(criteria or default_checklist(), scores)
        if calculated["final_score"] != row["score"]["final_score"]:
            raise ValueError("Итоговый балл не совпадает с расчётом по критериям")

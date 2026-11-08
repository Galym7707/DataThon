"""Bounded OpenAI evaluation with strict structure and source-verified evidence."""
import json
import os
from openai import OpenAI
from jsonschema import Draft202012Validator, ValidationError
from .scoring_engine import validate_value
from . import ai_gateway

from .evaluation_policy import SYSTEM_PROMPT, EVALUATION_POLICY_VERSION
from .scoring_engine import default_checklist

BASELINE_CODES = dict(zip(("01", "02", "03", "04", "05", "06", "07", "08"),
                          ("contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical")))
EVALUATION_OUTPUT_VERSION = "source-turn-v3"


def wire_checklist(criteria):
    baseline = {c["id"]: c for c in default_checklist()}
    identifiers = {c["id"] for c in criteria}
    fields = ("name", "description", "type", "max_scale", "levels", "allow_na", "na_condition")
    prepared = []
    for criterion in criteria:
        original = baseline.get(criterion["id"])
        same_rule = bool(original and all(criterion.get(key, original[key]) == original[key] for key in fields))
        alias = BASELINE_CODES.get(criterion["id"], criterion["id"])
        # A user-defined ID must never be overwritten by a baseline alias.
        code = alias if same_rule and alias not in identifiers else criterion["id"]
        prepared.append({**criterion, "id": code, "source_id": criterion["id"], "baseline_guidance": same_rule})
    return prepared


def allowed_proof_turns(criterion, transcript):
    turns = list(range(1, len(transcript) + 1))
    if criterion["baseline_guidance"] and criterion["source_id"] == "01":
        first_operator = next((i + 1 for i, m in enumerate(transcript)
                               if m.get("speaker") == "operator" and m.get("text", "").strip()), None)
        if first_operator is not None:
            return [first_operator]
    return turns


def response_schema(criteria, transcript=None):
    properties = {}
    for c in wire_checklist(criteria):
        value = {"type": "number", "enum": c["levels"]} if c["type"] == "scale" else {"type": "boolean"}
        if c["allow_na"]:
            value = {"anyOf": [value, {"type": "null"}]}
        if c["baseline_guidance"] and c["source_id"] == "07":
            value["description"] = ("true только при (итог ИЛИ предложение дальнейшей помощи) И прощание. "
                "Пожалуйста. Хорошего вечера! — false: есть лишь прощание. "
                "null только при подтверждённом обрыве. В rationale проверь оба элемента отдельно.")
        fields = {"criterion_id": {"type": "string", "enum": [c["id"]]}, "value": value,
                  "rationale": {"type": "string"}, "evidence_turns": {"type": "array", "minItems": 1, "items": {"type": "integer"}},
                  "proof_turn": {"type": "integer", "minimum": 1, "description": "Номер основной подтверждающей реплики с 1, обязательно из evidence_turns. Сервер сам возьмёт её текст и время."},
                  "recommendation": {"type": "string"}, "practice_task": {"type": "string"}}
        if transcript:
            # Repeating all turn IDs in every field exceeds the provider's
            # aggregate enum limit on calls with ~65+ turns. Bounds are compact.
            fields["proof_turn"]["maximum"] = len(transcript)
            fields["evidence_turns"]["items"].update(minimum=1, maximum=len(transcript))
            allowed = allowed_proof_turns(c, transcript)
            if c["baseline_guidance"] and c["source_id"] == "01" and len(allowed) == 1:
                fields["proof_turn"]["enum"] = allowed
        properties[c["id"]] = {"type": "object", "additionalProperties": False, "required": list(fields), "properties": fields}
    rows = {"type": "object", "additionalProperties": False, "required": list(properties), "properties": properties}
    review_fields = {"code": {"type": "string", "enum": ["insufficient_evidence", "unreadable_transcript", "unsupported_input"]},
                     "reason": {"type": "string"}}
    return {"type": "object", "additionalProperties": False, "required": ["status", "results", "manual_review"],
            "properties": {"status": {"type": "string", "enum": ["evaluated", "manual_review"]},
                           "results": {"anyOf": [rows, {"type": "null"}]},
                           "manual_review": {"anyOf": [{"type": "object", "additionalProperties": False,
                               "required": list(review_fields), "properties": review_fields}, {"type": "null"}]}}}


class ManualReviewRequired(ValueError):
    def __init__(self, reason, code="insufficient_evidence", usage=None):
        super().__init__(reason)
        self.reason, self.code, self.usage = reason, code, usage or {}


class EvaluationValidationError(ValueError):
    def __init__(self, message, usage):
        super().__init__(message)
        self.usage = usage

    @property
    def public_error(self):
        # Only fixed messages are exposed or stored. jsonschema errors may contain
        # model output; never serialize their instance, schema or exception text.
        code = {
            "Цитата ИИ не найдена в исходной реплике": "evidence_quote_mismatch",
            "Неподтверждённое время или пустое обоснование": "evidence_timestamp_mismatch",
            "Некорректные номера реплик в доказательствах": "invalid_evidence_turns",
            "ИИ сослался на отсутствующую реплику": "invalid_evidence_turns",
            "ИИ не завершил оценку или отказал; оценка не сохранена": "incomplete_response",
            "ИИ не дал рекомендацию для выявленной ошибки": "missing_recommendation",
            "Рекомендация и упражнение допустимы только для выявленной ошибки": "unexpected_recommendation",
            "Не удалось подтвердить связь цитаты с исходным сообщением.": "evidence_source_mismatch",
        }.get(str(self), "invalid_evaluation")
        return {"code": code, "message": ERROR_MESSAGES[code]}


ERROR_MESSAGES = {
    "evidence_quote_mismatch": "Цитата ИИ не совпала с текстом указанных реплик. Оценка не сохранена.",
    "evidence_timestamp_mismatch": "Время цитаты ИИ не совпало с исходной репликой. Оценка не сохранена.",
    "invalid_evidence_turns": "ИИ указал некорректные номера реплик. Оценка не сохранена.",
    "incomplete_response": "ИИ вернул незавершённый ответ или отказался от оценки. Результат не сохранён.",
    "missing_recommendation": "В ответе ИИ нет рекомендации по выявленной ошибке. Оценка не сохранена.",
    "unexpected_recommendation": "Рекомендация ИИ противоречит выставленной оценке. Результат не сохранён.",
    "evidence_source_mismatch": "Не удалось связать цитату ИИ с исходной перепиской. Оценка не сохранена.",
    "invalid_evaluation": "Ответ ИИ не прошёл проверку формата. Оценка не сохранена.",
    "provider_error": "Не удалось получить ответ AI-провайдера. Проверьте подключение и доступность API.",
    "provider_request_error": "AI-провайдер отклонил параметры запроса. Оценка не выполнена; требуется проверить формат запроса.",
    "preparation_error": "Не удалось проверить подготовленный запрос. Подготовьте новое превью.",
    "processing_error": "Не удалось завершить проверку. Оценка не сохранена.",
    "legacy_error": "Предыдущая попытка оценки завершилась ошибкой. Подробная причина не была сохранена.",
}


def source_excerpt(text, limit=180):
    """Take a literal prefix without splitting privacy placeholders or words."""
    text = text.strip()
    if len(text) <= limit:
        return text
    end = limit
    opening = text.rfind("[", 0, end)
    if opening > text.rfind("]", 0, end) and text.find("]", end) != -1:
        end = opening
    # Prefer a nearby word boundary; never add ellipses to a verified quote.
    space = text.rfind(" ", 0, end)
    if space >= max(0, end - 40):
        end = space
    return text[:end].rstrip()


def resolve_proof(raw, turns, transcript):
    """Select a source row. Never accept model-generated quote text or time."""
    turn = raw["proof_turn"]
    if type(turn) is not int or not 1 <= turn <= len(transcript) or turn not in turns:
        raise ValueError("Некорректные номера реплик в доказательствах")
    message = transcript[turn - 1]
    return {"proof_message_index": turn - 1, "proof_source": "transcript",
            "proof_quote": source_excerpt(message["text"]), "proof_timestamp": message["timestamp"]}


def validate_evidence(results, criteria, transcript):
    if len(results) != len(criteria) or {r["criterion_id"] for r in results} != {c["id"] for c in criteria}:
        raise ValueError("ИИ вернул неполный или повторяющийся набор критериев")
    lookup = {c["id"]: c for c in criteria}
    for r in results:
        validate_value(lookup[r["criterion_id"]], r["value"], r["is_na"])
        i = r["proof_message_index"]
        if type(i) is not int or not 0 <= i < len(transcript):
            raise ValueError("ИИ сослался на отсутствующую реплику")
        m = transcript[i]
        if not r["proof_quote"].strip() or r["proof_quote"] not in m["text"]:
            raise ValueError("Цитата ИИ не найдена в исходной реплике")
        if r["proof_timestamp"] != m["timestamp"] or not r["reason"].strip():
            raise ValueError("Неподтверждённое время или пустое обоснование")
    return results


def request_payload(conversation, criteria):
    # Every original turn retains its position, including client/bot/system.
    transcript = []
    for i, message in enumerate(conversation["transcript"]):
        transcript.append({"turn": i + 1, **{key: message[key] for key in
                           ("id", "message_id", "speaker", "timestamp", "text") if key in message}})
    return {"conversation_id": conversation.get("conversation_id", ""), "policy_version": EVALUATION_POLICY_VERSION,
            "output_version": EVALUATION_OUTPUT_VERSION,
            "checklist": wire_checklist(criteria), "language": conversation["language"],
            "channel": conversation["channel"], "transcript": transcript,
            "reference_materials": conversation.get("reference_materials") or []}


def normalize_response(result, criteria, transcript, usage):
    Draft202012Validator(response_schema(criteria)).validate(result)
    if result["status"] == "manual_review":
        review = result["manual_review"]
        if result["results"] is not None or not review or not 1 <= len(review["reason"].strip()) <= 1000:
            raise ValueError("Некорректный запрос ручного разбора")
        raise ManualReviewRequired(review["reason"].strip(), review["code"], usage)
    if result["manual_review"] is not None or result["results"] is None:
        raise ValueError("Неполный результат оценки")
    rows = []
    for criterion in wire_checklist(criteria):
        raw = result["results"][criterion["id"]]
        value = raw["value"]
        if value is not None:
            if criterion["type"] in ("binary", "flag"):
                if type(value) is not bool:
                    raise ValueError("Для бинарного критерия требуется true или false")
                value = int(value)
            elif type(value) not in (int, float):
                raise ValueError("Для шкалы требуется числовая ступень")
        turns = raw["evidence_turns"]
        if (not turns or any(type(turn) is not int or not 1 <= turn <= len(transcript) for turn in turns)
                or len(set(turns)) != len(turns)):
            raise ValueError("Некорректные номера реплик в доказательствах")
        if not 1 <= len(raw["rationale"].strip()) <= 1500:
            raise ValueError("Пустое или слишком длинное обоснование")
        if raw["proof_turn"] not in allowed_proof_turns(criterion, transcript):
            raise ValueError("Некорректные номера реплик в доказательствах")
        rows.append({"criterion_id": criterion["source_id"], "code": criterion["id"], "value": value,
                     "is_na": value is None, "reason": raw["rationale"].strip(), "rationale": raw["rationale"].strip(),
                     "evidence_turns": turns, **resolve_proof(raw, turns, transcript),
                     **{key: raw[key] for key in ("recommendation", "practice_task")}})
    return validate_evidence(rows, criteria, transcript)


def build_request(conversation, criteria, policy=None, extra_redactions=()):
    return ai_gateway.prepare_request(
        purpose="evaluation", target=conversation.get("conversation_id", ""),
        payload=request_payload(conversation, criteria), system_prompt=SYSTEM_PROMPT,
        response_schema=response_schema(criteria, conversation["transcript"]), schema_name="cqa_evaluation",
        model=os.getenv("OPENAI_MODEL", "gpt-4o"),
        max_tokens=int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "2600")),
        policy=policy, extra_redactions=extra_redactions)


def evaluate(conversation, criteria, prepared_request=None, policy=None):
    prepared, policy_getter = ai_gateway.resolve_request(
        "evaluation", lambda: build_request(conversation, criteria, policy), prepared_request, policy)
    if prepared.source_hash != ai_gateway.fingerprint(request_payload(conversation, criteria)):
        raise ai_gateway.PrivacyError("Диалог или чек-лист изменился. Подготовьте новое превью.")
    sent = prepared.payload()
    if not any(m.get("speaker") == "operator" and m.get("text", "").strip() for m in sent["transcript"]):
        raise ManualReviewRequired("В транскрипте нет реплик человека-оператора; оценка требует ручного разбора.", "unsupported_input")
    completion = ai_gateway.dispatch(prepared, policy_getter, client_factory=OpenAI)
    usage = completion.usage
    usage_data = {"prompt_tokens": usage.prompt_tokens, "completion_tokens": usage.completion_tokens,
                  "total_tokens": usage.total_tokens} if usage else {}
    try:
        if not completion.choices:
            raise ValueError("ИИ не вернул оценку")
        choice = completion.choices[0]
        if choice.finish_reason != "stop" or choice.message.refusal:
            raise ValueError("ИИ не завершил оценку или отказал; оценка не сохранена")
        result = json.loads(choice.message.content or "{}")
        results = normalize_response(result, criteria, sent["transcript"], usage_data)
        from .coaching import needs_practice
        lookup = {c["id"]: c for c in criteria}
        for r in results:
            # Coaching is supplementary, never evidence for the score. An absent
            # or unusable pair falls back to coaching.guidance's local rule text;
            # keep it empty here so that it cannot be misrepresented as AI advice.
            if (not needs_practice(lookup[r["criterion_id"]], r)
                    or any(not r[k].strip() or len(r[k]) > 700 for k in ("recommendation", "practice_task"))):
                r["recommendation"] = r["practice_task"] = ""
            else:
                r["recommendation"] = r["recommendation"].strip()
                r["practice_task"] = r["practice_task"].strip()
    except ManualReviewRequired:
        raise
    except (ValueError, KeyError, TypeError, AttributeError, ValidationError) as exc:
        message = str(exc) if isinstance(exc, ValueError) and not isinstance(exc,json.JSONDecodeError) else "Некорректная структура ответа ИИ"
        raise EvaluationValidationError(message, usage_data) from None
    # Restore only a source-verified span in the same original message. Never
    # unmask arbitrary model prose or trust a quote that merely matches original.
    try:
        for result in results:
            index = result["proof_message_index"]
            result["sent_proof_quote"] = result["proof_quote"]
            result["proof_quote"] = prepared.restore_quote(("transcript", index, "text"), result["proof_quote"])
            result["evidence_message_ids"] = [conversation["transcript"][turn - 1].get("message_id",
                conversation["transcript"][turn - 1].get("id")) for turn in result["evidence_turns"]]
            message = conversation["transcript"][index]
            if "message_id" in message or "id" in message:
                result["proof_message_id"] = message.get("message_id", message.get("id"))
    except ai_gateway.PrivacyError:
        raise EvaluationValidationError("Не удалось подтвердить связь цитаты с исходным сообщением.", usage_data) from None
    return {"results": results, "model": completion.model, "usage": usage_data, "policy_version": EVALUATION_POLICY_VERSION}

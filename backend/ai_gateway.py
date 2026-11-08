"""One fail-closed boundary for outgoing text AI requests.

The detector is a local heuristic, not guaranteed anonymisation. Original strings and
span maps live only in the prepared server object; previews never include that map.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
import copy
import hashlib
import json
import os
import re
from typing import Callable

from openai import OpenAI, OpenAIError, BadRequestError


class PrivacyError(ValueError):
    """Safe, content-free error suitable for displaying to the user."""


class ExternalAIBlocked(PrivacyError):
    pass


class ProviderRequestError(RuntimeError):
    """Provider rejected request parameters; contains no provider body or PII."""


def validate_schema_limits(schema):
    """Reject oversized enumeration schemas locally, before any paid request."""
    def enum_count(node):
        if isinstance(node, dict):
            values = node.get("enum", [])
            return (len(values) if isinstance(values, list) else 0) + sum(
                enum_count(value) for key, value in node.items() if key != "enum")
        if isinstance(node, list):
            return sum(enum_count(value) for value in node)
        return 0
    if enum_count(schema) > 1000:
        raise PrivacyError("Схема ответа AI превышает допустимую сложность. Упростите шкалы чек-листа; запрос не отправлен.")


def policy_from(value=None):
    if value is None:
        value = {"mask_personal_data": os.getenv("AI_MASK_PERSONAL_DATA", "true").lower() != "false",
                 "block_external_ai": os.getenv("AI_BLOCK_EXTERNAL", "false").lower() == "true", "revision": 1}
    if not isinstance(value, dict):
        raise PrivacyError("Не удалось проверить настройки защиты AI.")
    if any(type(value.get(k, default)) is not bool for k, default in (("mask_personal_data", True), ("block_external_ai", False))):
        raise PrivacyError("Некорректные настройки защиты AI.")
    revision = value.get("revision", 1)
    if type(revision) is not int or revision < 1:
        raise PrivacyError("Некорректная версия настроек защиты AI.")
    return {"mask_personal_data": value.get("mask_personal_data", True),
            "block_external_ai": value.get("block_external_ai", False), "revision": revision}


def require_external_allowed(policy=None):
    current = policy_from(policy)
    if current["block_external_ai"]:
        raise ExternalAIBlocked("Внешняя AI-обработка запрещена. Локальная модель не настроена; автоматический анализ недоступен.")
    return current


def _encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(_encoded(value).encode()).hexdigest()


# IDs, roles, times and mathematical values are structural, never sent through a
# numeric catch-all. This preserves the evidence reference and scoring semantics.
STRUCTURAL_KEYS = {"id", "conversation_id", "criterion_id", "evaluation_id", "message_id", "index",
                   "target_message_index", "proof_message_index", "timestamp", "proof_timestamp", "speaker",
                   "role", "language", "channel", "type", "status", "feedback_language", "candidate_id"}
MEDIA_KEYS = {"audio", "audio_url", "input_audio", "image", "image_url", "images", "video", "video_url",
              "attachments", "file", "file_data", "file_url"}
PERSON_KEYS = {"full_name", "first_name", "last_name", "customer_name", "client_name", "employee_name", "operator_name"}
SECRET_KEYS = {"password", "passcode", "otp", "pin", "secret", "api_key", "access_token"}
NAME_PART = r"[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+(?:[-'][A-ZА-ЯЁӘҒҚҢӨҰҮҺІ]?[a-zа-яёәғқңөұүһі]+)?"
NAME = rf"{NAME_PART}(?:\s+{NAME_PART}){{0,2}}"
PATTERNS = [
    ("EMAIL", re.compile(r"(?<![\w.+-])[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+", re.I), 0),
    ("ИИН", re.compile(r"(?<!\d)\d{12}(?!\d)"), 0),
    ("ИИН", re.compile(r"(?:иин|жсн|iin)\s*[:=–-]?\s*((?:\d[ -]?){11}\d)(?!\d)", re.I), 1),
    ("СЧЁТ", re.compile(r"\b(?:KZ\d{2}(?: ?[A-Z0-9]{4}){4}|[A-Z]{2}\d{2}[A-Z0-9]{11,30})\b", re.I), 0),
    ("КАРТА", re.compile(r"(?<!\d)(?:\d[ -]?){15}\d(?!\d)"), 0),
    ("ТЕЛЕФОН", re.compile(r"(?<!\w)(?:\+7|7|8)[ ()-]*\d{3}[ ()-]*\d{3}[ -]*\d{2}[ -]*\d{2}(?!\d)"), 0),
    ("ТЕЛЕФОН", re.compile(r"(?<!\w)\+[1-9](?:[ ()-]*\d){7,14}(?!\d)"), 0),
    ("ТЕЛЕФОН", re.compile(r"(?:телефон(?:ым|ы)?|phone|mobile|ұялы(?:\s+телефон)?)\s*[:=–-]?\s*((?:\+?\d[ ()-]*){7,15})", re.I), 1),
    ("СЧЁТ", re.compile(r"(?:номер\s+(?:сч[её]та|карты)|account(?:\s+number)?|card(?:\s+number)?|шот(?:\s+нөмірі)?|карта(?:\s+нөмірі)?)\s*[:=#–-]?\s*([A-Z]{0,2}(?:\d[ -]?){7,24}\d)", re.I), 1),
    ("ПАРОЛЬ", re.compile(r"(?:пароль(?:\s+от\s+\w+)?|password|құпиясөз|құпия\s+сөз)\s*(?:[:=–-]|это|is)?\s*([^\s,;]{3,80})", re.I), 1),
    ("КОД", re.compile(r"(?:одноразов\w*\s+код|код\s+(?:из\s+)?(?:смс|sms|подтверждения)|sms[ -]?code|otp|one[ -]time\s+(?:code|password)|verification\s+code|растау\s+коды|бір\s*реттік\s+код|pin(?:[ -]code)?)\s*[:=–-]?\s*([\dA-Z-]{3,12})", re.I), 1),
    ("ИМЯ", re.compile(rf"(?:меня\s+зовут|мо[её]\s+имя|фио|ф\.и\.о\.|my\s+name\s+is|full\s+name|аты[ -]ж[өо]н(?:ім|і)|менің\s+атым|есімім|мен\s+оператор|оператор(?:дың)?\s+аты)\s*[:=–-]?\s*({NAME})", re.I), 1),
    ("ИМЯ", re.compile(rf"(?i:(?:this\s+is|i\s+am))\s+({NAME})(?i:[, ]+(?:speaking|your\s+(?:agent|operator|advisor)))"), 1),
    ("ИМЯ", re.compile(rf"(?i:я)\s+({NAME})[, ]+(?i:оператор|консультант)"), 1),
    ("ИМЯ", re.compile(rf"(?<!\w)({NAME_PART}\s+[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+(?:ов|ова|ев|ева|ин|ина|ұлы|қызы))(?!\w)"), 1),
    ("ИМЯ", re.compile(rf"(?<!\w)({NAME_PART}\s+{NAME_PART}\s+[A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]*(?:вич|вна|ұлы|қызы))(?!\w)"), 1),
    ("ИМЯ", re.compile(rf"(?<!\w)([A-ZА-ЯЁӘҒҚҢӨҰҮҺІ][a-zа-яёәғқңөұүһі]+(?:ов|ова|ев|ева|ин|ина|ұлы|қызы)\s+{NAME_PART})(?!\w)"), 1),
    ("АДРЕС", re.compile(r"(?:адрес(?:\s+проживания)?|address|мекенжай(?:ым|ы)?)\s*[:=–-]\s*([^\n;!?]{3,180})", re.I), 1),
    ("АДРЕС", re.compile(r"(?:\bул\.?|улица|проспект|пр-т|көшесі|көше|street|avenue|road)\s+[А-ЯЁӘҒҚҢӨҰҮҺІA-Z0-9][^\n;!?]{0,90}?\s+\d+[A-ZА-Яа-я]?(?:[, ]+(?:д\.?|дом|кв\.?|квартира|apt\.?|үй|пәтер)\s*\d+)?", re.I), 0),
    ("АДРЕС", re.compile(r"(?:улиц[аеуы]|ул\.|проспект|пр-т)\s+[А-ЯЁӘҒҚҢӨҰҮҺІA-Z][а-яёәғқңөұүһіa-z .-]{1,45}?,?\s*(?:д\.?|дом)?\s*\d+[А-Яа-яA-Z]?(?:[, ]+(?:кв\.?|квартира)\s*\d+)?", re.I), 0),
    ("АДРЕС", re.compile(r"[А-ЯЁӘҒҚҢӨҰҮҺІA-Z][а-яёәғқңөұүһіa-z-]+(?:\s+[А-ЯЁӘҒҚҢӨҰҮҺІA-Z][а-яёәғқңөұүһіa-z-]+)?\s+(?:көшесі|даңғылы),?\s*\d+\s*(?:үй)?(?:[, ]+\d+\s*пәтер)?", re.I), 0),
    ("АДРЕС", re.compile(r"\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,4}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Lane|Drive)\b(?:[, ]+(?:Apt\.?|Suite)\s*\w+)?", re.I), 0),
]


@dataclass
class TextMap:
    original: str = field(repr=False)
    masked: str = field(repr=False)
    boundaries: list = field(repr=False)

    def restore(self, quote):
        if not isinstance(quote, str) or not quote or quote not in self.masked:
            raise PrivacyError("Цитата не найдена в содержимом, отправленном AI.")
        start = self.masked.find(quote)
        end = start + len(quote)
        if self.boundaries[start] is None or self.boundaries[end] is None:
            raise PrivacyError("Цитата обрывает скрытое значение; доказательство не подтверждено.")
        return self.original[self.boundaries[start]:self.boundaries[end]]


class LocalMasker:
    def __init__(self, extra_redactions=()):
        if not isinstance(extra_redactions, (list, tuple)) or len(extra_redactions) > 40 or any(
                not isinstance(x, str) or not 1 <= len(x.strip()) <= 200 for x in extra_redactions):
            raise PrivacyError("Укажите не больше 40 значений для скрытия длиной от 1 до 200 символов.")
        self.values = {}
        self.counts = {}
        self.maps = {}
        self.extras = [s.strip() for s in extra_redactions]

    def remember(self, value, kind, role=None):
        value = value.strip()
        if not value or value.startswith("["):
            return
        normalized = value.casefold()
        if normalized in self.values:
            return
        if kind == "ИМЯ":
            kind = {"client": "КЛИЕНТ", "operator": "ОПЕРАТОР"}.get(role, "ИМЯ")
        self.counts[kind] = self.counts.get(kind, 0) + 1
        self.values[normalized] = (value, f"[{kind}_{self.counts[kind]}]")

    def discover(self, text, role=None, key=None):
        if key in PERSON_KEYS:
            self.remember(text, "ИМЯ", role)
        if key in SECRET_KEYS:
            self.remember(text, "ПАРОЛЬ")
        for kind, regex, group in PATTERNS:
            for match in regex.finditer(text):
                value = match.group(group).rstrip(" .,")
                if kind in ("ПАРОЛЬ", "КОД") and value.casefold() in {
                    "нельзя", "нужно", "нужен", "сообщайте", "передавайте", "можно", "новый", "одноразовый",
                    "требуется", "необходимо", "must", "should", "never", "not", "required", "please", "needed",
                    "құпия", "айтпаңыз", "жібермеңіз", "керек", "password", "code", "пароль", "коду"}:
                    continue
                if kind == "ИМЯ":
                    # Contextual intros also support lowercase input, stopping at
                    # connectors so the action/identity statement stays intact.
                    stop = {"я", "мне", "и", "вам", "ваш", "буду", "это", "мен", "және", "сізге", "сіздің", "and", "i", "your", "speaking", "from", "is", "оператор", "консультант", "клиент", "operator", "agent", "customer", "client"}
                    words = value.split()
                    end = next((i for i, word in enumerate(words) if word.casefold() in stop), len(words))
                    value = " ".join(words[:end])
                if kind == "АДРЕС":
                    # Stop at a new sentence, while retaining street abbreviations.
                    value = re.split(r"\.\s+(?=[А-ЯЁA-Z][а-яёa-z]{2,}\s)", value, maxsplit=1)[0]
                self.remember(value, kind, role)
        for value in self.extras:
            self.remember(value, "СКРЫТО")

    def mask(self, text, path):
        matches = []
        for original, placeholder in self.values.values():
            left = r"(?<!\w)" if original[0].isalnum() else ""
            right = r"(?!\w)" if original[-1].isalnum() else ""
            for match in re.finditer(left + re.escape(original) + right, text, re.I):
                matches.append((match.start(), match.end(), placeholder))
        # Longest match wins when several detectors recognise the same PII.
        selected = []
        for start, end, placeholder in sorted(matches, key=lambda m: (m[0], -(m[1] - m[0]))):
            if selected and start < selected[-1][1]:
                continue
            selected.append((start, end, placeholder))
        pieces, boundaries, pos = [], [0], 0
        for start, end, placeholder in selected:
            pieces.append(text[pos:start])
            boundaries.extend(range(pos + 1, start + 1))
            pieces.append(placeholder)
            boundaries.extend([None] * (len(placeholder) - 1) + [end])
            pos = end
        pieces.append(text[pos:])
        boundaries.extend(range(pos + 1, len(text) + 1))
        masked = "".join(pieces)
        self.maps[tuple(path)] = TextMap(text, masked, boundaries)
        return masked


def _walk(value, callback, path=(), role=None):
    if isinstance(value, dict):
        current_role = value.get("speaker", value.get("role", role))
        result = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise PrivacyError("Не удалось подготовить содержимое AI: некорректная структура.")
            if key.lower() in MEDIA_KEYS and item not in (None, "", [], {}):
                raise PrivacyError("В первой версии внешнему AI можно отправлять только текст. Необработанные аудио и изображения заблокированы.")
            if key in STRUCTURAL_KEYS:
                if not isinstance(item, (str, int, float, bool, type(None))):
                    raise PrivacyError("Некорректные идентификаторы или время сообщения.")
                result[key] = copy.deepcopy(item)
            else:
                result[key] = _walk(item, callback, path + (key,), current_role)
        return result
    if isinstance(value, list):
        return [_walk(item, callback, path + (i,), role) for i, item in enumerate(value)]
    if isinstance(value, str):
        if value.startswith("data:image/") or value.startswith("data:audio/"):
            raise PrivacyError("Внешняя отправка необработанных медиафайлов заблокирована.")
        return callback(value, path, role)
    if value is None or type(value) in (int, float, bool):
        return value
    raise PrivacyError("Не удалось подготовить содержимое AI: неподдерживаемое значение.")


@dataclass(frozen=True)
class PreparedRequest:
    purpose: str
    target: str
    privacy: dict = field(repr=False)
    request_json: str = field(repr=False)
    integrity: str = field(repr=False)
    maps: dict = field(repr=False, compare=False)
    source_hash: str = field(repr=False)

    def request(self):
        if hashlib.sha256(self.request_json.encode()).hexdigest() != self.integrity:
            raise PrivacyError("Подготовленный запрос изменился. Откройте актуальное превью.")
        return json.loads(self.request_json)

    def preview(self):
        return {"provider": "openai", "purpose": self.purpose, "target": self.target,
                "privacy_revision": self.privacy["revision"], "mask_personal_data": self.privacy["mask_personal_data"],
                "request": self.request()}

    def payload(self):
        return json.loads(self.request()["messages"][1]["content"])

    def restore_quote(self, path, quote):
        mapping = self.maps.get(tuple(path))
        if mapping is None:
            raise PrivacyError("Не удалось связать доказательство с исходным сообщением.")
        return mapping.restore(quote)


def prepare_request(*, purpose, target, payload, system_prompt, response_schema, schema_name, model,
                    max_tokens, policy=None, extra_redactions=()):
    policy = require_external_allowed(policy)
    try:
        if not isinstance(payload, dict) or not isinstance(system_prompt, str) or not system_prompt.strip():
            raise PrivacyError("Некорректное содержимое запроса AI.")
        validate_schema_limits(response_schema)
        masker = LocalMasker(extra_redactions)
        if policy["mask_personal_data"]:
            _walk(payload, lambda text, path, role: (masker.discover(text, role, path[-1] if path else None), text)[1])
        else:
            for value in masker.extras:
                masker.remember(value, "СКРЫТО")
        masked = _walk(payload, lambda text, path, role: masker.mask(text, path))
        request = {"model": model, "temperature": 0, "max_tokens": max_tokens, "store": False,
                   "response_format": {"type": "json_schema", "json_schema": {
                       "name": schema_name, "strict": True, "schema": response_schema}},
                   "messages": [{"role": "system", "content": system_prompt},
                                {"role": "user", "content": json.dumps(masked, ensure_ascii=False)}]}
        # Canonical sorting is for fingerprints only. Structured Outputs follows
        # schema property order: keep the decision before its dependent fields.
        request_json = json.dumps(request, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        return PreparedRequest(purpose, str(target), copy.deepcopy(policy), request_json,
                               hashlib.sha256(request_json.encode()).hexdigest(), masker.maps, fingerprint(payload))
    except PrivacyError:
        raise
    except Exception:
        # Never interpolate the original payload, provider content or mappings.
        raise PrivacyError("Не удалось подготовить защищённый запрос. Отправка заблокирована.") from None


_request_context = ContextVar("ai_request_context", default=None)


@contextmanager
def request_context(prepared, policy_getter: Callable):
    token = _request_context.set((prepared, policy_getter))
    try:
        yield
    finally:
        _request_context.reset(token)


def resolve_request(purpose, builder, prepared_request=None, policy=None):
    context = _request_context.get()
    prepared = prepared_request or (context[0] if context else None) or builder()
    if not isinstance(prepared, PreparedRequest) or prepared.purpose != purpose:
        raise PrivacyError("Превью относится к другому действию AI.")
    getter = context[1] if context else lambda: policy_from(policy)
    return prepared, getter


def dispatch(prepared, current_policy=None, client_factory=None):
    policy = require_external_allowed(current_policy() if callable(current_policy) else current_policy)
    if policy != prepared.privacy:
        raise PrivacyError("Настройки защиты изменились. Подготовьте и подтвердите новое превью.")
    request = prepared.request()
    if request.get("store") is not False:
        raise PrivacyError("Не удалось проверить параметры хранения запроса AI.")
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        raise PrivacyError("OPENAI_API_KEY не настроен на сервере.")
    try:
        client = (client_factory or OpenAI)(api_key=api_key, max_retries=0, timeout=75)
        # Recheck after client construction too: there is no fallback transport.
        latest = require_external_allowed(current_policy() if callable(current_policy) else current_policy)
        if latest != prepared.privacy:
            raise PrivacyError("Настройки защиты изменились. Подготовьте новое превью.")
        return client.chat.completions.create(**request)
    except OpenAIError as exc:
        if isinstance(exc, BadRequestError):
            raise ProviderRequestError("OpenAI отклонил параметры запроса; автоматических повторов нет.") from None
        raise RuntimeError(f"OpenAI: {type(exc).__name__}. Проверьте доступ, квоту и сеть; автоматических повторов нет.") from None

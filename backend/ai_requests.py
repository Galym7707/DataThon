"""Server-owned previews, privacy policy, and read-only manager AI endpoints."""
import copy
import hashlib
import json
import os
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from . import ai_gateway, ai_evaluator, ai_coach, manager_assistant
from .dataset import scoped_data


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def timestamp():
    return datetime.now(timezone.utc).isoformat()


class PrivacyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mask_personal_data: bool = Field(strict=True)
    block_external_ai: bool = Field(strict=True)


class PrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    purpose: Literal["evaluation", "batch", "practice", "assistant_search", "assistant_recommendations"]
    conversation_id: str | None = Field(default=None, max_length=200)
    conversation_ids: list[str] = Field(default_factory=list, max_length=65)
    force: bool = False
    criterion_id: str | None = Field(default=None, max_length=100)
    answer: str | None = Field(default=None, max_length=5000)
    language: Literal["ru", "kk", "en"] = "ru"
    query: str = Field(default="", max_length=2000)
    filters: dict = Field(default_factory=dict)
    dataset_group: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,40}$")
    redactions: list[str] = Field(default_factory=list, max_length=40)


class AssistantSend(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preview_id: str = Field(min_length=20, max_length=100)


class FilterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filters: dict = Field(default_factory=dict)
    dataset_group: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,40}$")


class AssistantResponseError(ValueError):
    """Only a fixed diagnostic code is stored; never provider text or the query."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


ASSISTANT_ERRORS = {
    "incomplete": "AI не закончил ответ в пределах лимита. Ответ не применён; автоматический повтор не выполнялся.",
    "refusal": "AI отказался обрабатывать этот запрос. Фильтры и оценки не изменены.",
    "invalid_command": "AI вернул некорректную команду поиска. Фильтры и оценки не изменены; автоматический повтор не выполнялся.",
    "provider_request": "AI-провайдер отклонил формат запроса. Требуется исправление приложения; менять формулировку вопроса не нужно.",
    "provider_unavailable": "Не удалось получить ответ AI-провайдера. Проверьте подключение и доступность API. Автоматический повтор не выполнялся.",
    "internal": "Не удалось обработать ответ помощника. Фильтры и оценки не изменены; автоматический повтор не выполнялся.",
}


class AIRequests:
    def __init__(self, store, role, get_record):
        self.store, self.role, self.get_record = store, role, get_record
        self.tickets = {}
        self.exercise = None
        self.assistant_active = False

    def policy(self):
        return {"mask_personal_data": True, "block_external_ai": False, "revision": 1,
                **self.store.data.get("ai_privacy", {})}

    def require_external(self):
        if self.policy()["block_external_ai"]:
            raise HTTPException(403, "Внешняя AI-обработка запрещена. Локальная модель не настроена; автоматический анализ недоступен. Просмотр и ручная работа доступны.")

    def assistant_budget(self):
        settings = manager_assistant.assistant_settings()
        limit = settings["limit"]
        attempts = self.store.data.get("assistant_budget", {}).get("attempts", 0)
        return {"attempts": attempts, "limit": limit,
                "remaining": None if limit is None else max(0, limit - attempts),
                "unlimited": limit is None, "model": settings["model"]}

    def status_map(self):
        return {cid: self.store.status(cid) for cid in self.store.data["records"]}

    def source(self, spec):
        if spec["purpose"] in ("evaluation", "practice"):
            cid = spec["conversation_id"]
            return fingerprint({"record": self.get_record(cid), "checklist": self.store.data["checklist"],
                                "evaluation_policy_version": ai_evaluator.EVALUATION_POLICY_VERSION,
                                "evaluation_output_version": ai_evaluator.EVALUATION_OUTPUT_VERSION,
                                "evaluation": self.store.data["evaluations"].get(cid),
                                "appeals": [a for a in self.store.data["appeals"] if a["conversation_id"] == cid]})
        if spec["purpose"] == "batch":
            return fingerprint([self.source({"purpose": "evaluation", "conversation_id": cid}) for cid in spec["conversation_ids"]])
        return fingerprint({k: self.store.data.get(k) for k in ("records", "checklist", "evaluations", "appeals", "history", "evaluation_errors", "dataset_group_id", "record_groups")})

    def entry(self, prepared, spec):
        return {"prepared": prepared, "source": self.source(spec), "spec": spec}

    def check_budget(self, count=1, assistant=False):
        self.require_external()
        if not os.getenv("OPENAI_API_KEY"):
            raise HTTPException(503, "Ключ AI не настроен на сервере.")
        remaining = self.store.budget()["remaining"]
        if remaining is not None and remaining < count:
            raise HTTPException(429, "Недостаточно доступных AI-запросов для этой операции.")
        assistant_remaining = self.assistant_budget()["remaining"] if assistant else None
        if assistant_remaining is not None and assistant_remaining < count:
            raise HTTPException(429, "Лимит AI-помощника исчерпан.")

    def prepare(self, body, actor):
        spec = body.model_dump()
        if any(not value.strip() or len(value) > 200 for value in body.redactions):
            raise HTTPException(422, "Укажите до 40 фрагментов для скрытия, каждый от 1 до 200 символов.")
        entries, catalog = [], None
        policy = self.policy()
        self.require_external()
        if body.purpose in ("evaluation", "batch"):
            ids = list(dict.fromkeys(body.conversation_ids)) if body.purpose == "batch" else [body.conversation_id]
            if not ids or any(not cid for cid in ids):
                raise HTTPException(422, "Выберите диалог для оценки.")
            for cid in ids:
                record = copy.deepcopy(self.get_record(cid))
                self.store.require_evaluation_allowed(cid)
                target_spec = {"purpose": "evaluation", "conversation_id": cid, "force": body.force if body.purpose == "evaluation" else False}
                if self.store.status(cid) == "Evaluated" and not target_spec["force"]:
                    continue
                if any(a["conversation_id"] == cid and a["status"] == "PENDING" for a in self.store.data["appeals"]):
                    raise HTTPException(409, "Сначала рассмотрите ожидающие апелляции.")
                prepared = ai_evaluator.build_request(record, self.store.data["checklist"]["criteria"], policy=policy, extra_redactions=body.redactions)
                entries.append(self.entry(prepared, target_spec))
        elif body.purpose == "practice":
            if not body.conversation_id or not body.criterion_id or not body.answer or not body.answer.strip():
                raise HTTPException(422, "Выберите упражнение и напишите ответ.")
            exercise = self.exercise(body.conversation_id, body.criterion_id)
            answer = body.answer.strip()
            signature = fingerprint({"exercise_key": exercise["exercise_key"], "answer": answer, "language": body.language})
            if not any(a["signature"] == signature for a in self.store.data.get("practice_attempts", [])):
                prepared = ai_coach.build_request(exercise, answer, body.language, policy=policy, extra_redactions=body.redactions)
                entries.append(self.entry(prepared, spec))
        else:
            criteria = self.store.data["checklist"]["criteria"]
            data = scoped_data(self.store.data, body.dataset_group)
            filters = manager_assistant.normalize_filters(body.filters, criteria)
            spec["filters"] = filters
            if body.purpose == "assistant_search":
                if not body.query.strip():
                    raise HTTPException(422, "Напишите запрос помощнику.")
                definition = manager_assistant.build_search_request(body.query, filters, criteria, body.language)
            else:
                definition = manager_assistant.build_recommendation_request(data, self.status_map(), filters, body.language)
                catalog = definition.get("catalog")
                if not catalog:
                    raise HTTPException(422, "Недостаточно подтверждённых данных для рекомендаций. Сначала просмотрите охват и результаты оценок.")
            prepared = ai_gateway.prepare_request(
                purpose=definition["purpose"], target=definition["target"], payload=definition["payload"],
                system_prompt=definition["system_prompt"], response_schema=definition["schema"],
                model=definition["model"], max_tokens=definition["max_tokens"], policy=policy,
                extra_redactions=body.redactions, schema_name=definition["schema_name"])
            entries.append(self.entry(prepared, spec))
        if entries:
            self.check_budget(len(entries), assistant=body.purpose.startswith("assistant_"))
        clock = time.time()
        self.tickets = {key: ticket for key, ticket in self.tickets.items() if ticket["expires"] > clock}
        while len(self.tickets) >= 64:
            self.tickets.pop(next(iter(self.tickets)))
        preview_id = secrets.token_urlsafe(32)
        ticket = {"actor": actor, "spec": spec, "source": self.source(spec), "entries": entries,
                  "policy": policy, "expires": clock + 600, "catalog": catalog}
        self.tickets[preview_id] = ticket
        return {"preview_id": preview_id, "purpose": body.purpose, "expires_at": datetime.fromtimestamp(ticket["expires"], timezone.utc).isoformat(),
                "requests": [entry["prepared"].preview() for entry in entries], "cached": not entries}

    def consume(self, preview_id, actor, purpose, expected=None):
        if not preview_id:
            raise HTTPException(428, "Сначала откройте «Что получит AI» и подтвердите подготовленный запрос.")
        ticket = self.tickets.get(preview_id)
        if not ticket or ticket["expires"] <= time.time():
            raise HTTPException(409, "Предпросмотр истёк. Подготовьте его заново.")
        if ticket["actor"] != actor or ticket["spec"]["purpose"] != purpose:
            raise HTTPException(403, "Предпросмотр подготовлен для другой роли или операции.")
        self.require_external()
        if ticket["policy"] != self.policy() or ticket["source"] != self.source(ticket["spec"]):
            raise HTTPException(409, "Данные или режим защиты изменились. Обновите предпросмотр перед отправкой.")
        for key, value in (expected or {}).items():
            if ticket["spec"].get(key) != value:
                raise HTTPException(409, "Содержимое запроса изменилось. Обновите предпросмотр.")
        self.tickets.pop(preview_id)
        return ticket

    def verify_entry(self, entry):
        self.require_external()
        if not entry or entry["source"] != self.source(entry["spec"]):
            raise HTTPException(409, "Исходные данные изменились. Подготовьте запрос заново.")

    def audit(self, actor, purpose, cid=None):
        policy = self.policy()
        self.store.event("external_ai_request", actor, conversation_id=cid, provider="openai", purpose=purpose,
                         protection="masked" if policy["mask_personal_data"] else "original_text", privacy_revision=policy["revision"])

    def register(self, app):
        @app.get("/api/ai/privacy")
        def privacy(request: Request):
            self.role(request)
            return self.policy()

        @app.post("/api/ai/privacy")
        def save_privacy(body: PrivacyUpdate, request: Request):
            actor = self.role(request, "supervisor")
            with self.store.lock:
                current = self.policy()
                self.store.data["ai_privacy"] = {**body.model_dump(), "revision": current["revision"] + 1}
                self.store.event("ai_privacy_updated", actor, **self.store.data["ai_privacy"])
                self.store.save()
                self.tickets.clear()
                return self.policy()

        @app.post("/api/ai/prepare")
        def prepare(body: PrepareRequest, request: Request):
            actor = self.role(request, None if body.purpose == "practice" else "supervisor")
            with self.store.lock:
                try:
                    return self.prepare(body, actor)
                except HTTPException:
                    raise
                except Exception:
                    raise HTTPException(422, "Не удалось безопасно подготовить запрос. Отправка заблокирована; оригинал не отправлен.") from None

        @app.post("/api/assistant/filter")
        def assistant_filter(body: FilterRequest, request: Request):
            self.role(request, "supervisor")
            with self.store.lock:
                try:
                    filters = manager_assistant.normalize_filters(body.filters, self.store.data["checklist"]["criteria"])
                    result = manager_assistant.execute_search(scoped_data(self.store.data, body.dataset_group), self.status_map(), filters)
                    return {**result, "kind": "search", "result_count": result["total"], "dataset_group": body.dataset_group}
                except ValueError:
                    raise HTTPException(422, "Некорректные условия поиска.") from None

        @app.get("/api/assistant/history")
        def assistant_history(request: Request):
            self.role(request, "supervisor")
            with self.store.lock:
                return {"messages": copy.deepcopy(self.store.data.get("assistant_history", [])[-40:]),
                        "assistant_budget": self.assistant_budget(), "auth_mode": "supervisor-token" if os.getenv("QA_SUPERVISOR_TOKEN") else "local-demo"}

        @app.post("/api/assistant")
        def assistant_send(body: AssistantSend, request: Request):
            actor = self.role(request, "supervisor")
            with self.store.lock:
                raw = self.tickets.get(body.preview_id)
                purpose = (raw or {}).get("spec", {}).get("purpose", "assistant_search")
                if not purpose.startswith("assistant_"):
                    raise HTTPException(403, "Это предпросмотр другой операции.")
                if self.assistant_active:
                    raise HTTPException(409, "Дождитесь ответа помощника.")
                self.check_budget(assistant=True)
                ticket = self.consume(body.preview_id, actor, purpose)
                self.store.data["budget"]["attempts"] += 1
                self.store.data.setdefault("assistant_budget", {"attempts": 0})["attempts"] += 1
                self.audit(actor, purpose)
                self.store.save()
                self.assistant_active = True
                criteria = copy.deepcopy(self.store.data["checklist"]["criteria"])
            usage = {}
            try:
                prepared = ticket["entries"][0]["prepared"]
                def current_policy():
                    with self.store.lock:
                        if ticket["source"] != self.source(ticket["spec"]):
                            raise HTTPException(409, "Данные изменились. Обновите предпросмотр.")
                        return self.policy()
                completion = ai_gateway.dispatch(prepared, current_policy)
                if completion.usage:
                    usage = {"prompt_tokens": completion.usage.prompt_tokens, "completion_tokens": completion.usage.completion_tokens}
                if not completion.choices or completion.choices[0].finish_reason != "stop":
                    raise AssistantResponseError("incomplete")
                if completion.choices[0].message.refusal:
                    raise AssistantResponseError("refusal")
                try:
                    payload = json.loads(completion.choices[0].message.content or "{}")
                except (ValueError, TypeError):
                    raise AssistantResponseError("invalid_command") from None
                with self.store.lock:
                    if ticket["source"] != self.source(ticket["spec"]):
                        raise HTTPException(409, "Данные обновились во время ответа. Повторите запрос с новым предпросмотром.")
                    data = scoped_data(self.store.data, ticket["spec"].get("dataset_group"))
                    if purpose == "assistant_search":
                        try:
                            result = manager_assistant.parse_search_response(payload, criteria, ticket["spec"]["filters"])
                        except ValueError:
                            raise AssistantResponseError("invalid_command") from None
                        if result["kind"] == "search":
                            result = {**manager_assistant.execute_search(data, self.status_map(), result["filters"]), "kind": "search"}
                            result["result_count"] = result["total"]
                        elif result["kind"] == "summary":
                            result = manager_assistant.summarize_issues(data, self.status_map(), result["filters"])
                        elif result["kind"] == "recommendations":
                            result = {"kind": "recommendations_available", "filters": result["filters"]}
                    else:
                        try:
                            recommendations = manager_assistant.parse_recommendation_response(payload, ticket["catalog"])
                        except ValueError:
                            raise AssistantResponseError("invalid_command") from None
                        summary = manager_assistant.execute_search(data, self.status_map(), ticket["spec"]["filters"])
                        result = {"kind": "recommendations", "recommendations": recommendations, "filters": ticket["spec"]["filters"],
                                  "coverage": summary["coverage"], "filtered_coverage": summary.get("filtered_coverage"), "dataset": summary.get("dataset")}
                    result["dataset_group"] = ticket["spec"].get("dataset_group")
                    for key in ("prompt_tokens", "completion_tokens"):
                        self.store.data["budget"][key] += usage.get(key, 0)
                    self.store.data.setdefault("assistant_history", []).append({"id": str(uuid.uuid4()), "created_at": timestamp(),
                        "query": ticket["spec"]["query"] or "На что обратить внимание?", "response": copy.deepcopy(result)})
                    self.store.data["assistant_history"] = self.store.data["assistant_history"][-40:]
                    self.store.event("assistant_completed", actor, purpose=purpose, usage=usage)
                    self.store.save()
                    return {**result, "budget": self.store.budget(), "assistant_budget": self.assistant_budget()}
            except Exception as exc:
                usage = getattr(exc, "usage", usage)
                code = (exc.code if isinstance(exc, AssistantResponseError) else
                        "provider_request" if isinstance(exc, ai_gateway.ProviderRequestError) else
                        "provider_unavailable" if isinstance(exc, RuntimeError) else "internal")
                with self.store.lock:
                    for key in ("prompt_tokens", "completion_tokens"):
                        self.store.data["budget"][key] += usage.get(key, 0)
                    self.store.event("assistant_failed", actor, purpose=purpose, error_type=type(exc).__name__, error_code=code, usage=usage)
                    self.store.save()
                if isinstance(exc, HTTPException):
                    raise
                raise HTTPException(502, ASSISTANT_ERRORS[code]) from None
            finally:
                with self.store.lock:
                    self.assistant_active = False

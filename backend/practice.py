"""Version-bound practice with durable shared budget and idempotent submissions."""
import copy
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from . import ai_coach, ai_gateway
from .coaching import recommendations


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def timestamp():
    return datetime.now(timezone.utc).isoformat()


class PracticeAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    exercise_key: str = Field(pattern=r"^[a-f0-9]{64}$")
    evaluation_id: str = Field(min_length=1, max_length=100)
    answer: str = Field(min_length=1, max_length=5000)
    language: Literal["ru", "kk", "en"] = "ru"
    request_id: uuid.UUID
    preview_id: str | None = Field(default=None, max_length=100)


def register_practice(app, store, role, get_record, ai_requests):
    def exercise(cid, criterion_id):
        record = get_record(cid)
        if store.status(cid) != "Evaluated":
            raise HTTPException(409, "Для практики нужна актуальная оценка диалога.")
        evaluation = store.data["evaluations"][cid]
        criteria = store.data["checklist"]["criteria"]
        item = next((r for r in recommendations(evaluation, criteria) if r["criterion_id"] == criterion_id), None)
        if item is None:
            raise HTTPException(409, "По этому критерию нет актуальной ошибки для практики.")
        c = next(c for c in criteria if c["id"] == criterion_id)
        r = next(r for r in evaluation["results"] if r["criterion_id"] == criterion_id)
        # Exclude weights: a weight-only recalculation does not change this exercise.
        rule = {k: v for k, v in c.items() if k != "weight"}
        key = fingerprint({"evaluation_id": evaluation["id"], "record": record, "rule": rule, "result": r})
        transcript = record["transcript"]
        proof_index = item["proof_message_index"]
        target = proof_index
        if transcript[target]["speaker"] != "operator":
            target = next((i for i in range(target, len(transcript)) if transcript[i]["speaker"] == "operator"), target)
        # Show all context leading up to the replacement, collapsing it in the UI if needed.
        # No future replies can unfairly earn credit for the learner's answer.
        context = [{"index": i, **m} for i, m in enumerate(transcript[:target + 1])]
        return copy.deepcopy({**item, "criterion": c, "exercise_key": key,
                              "evaluation_id": evaluation["id"], "target_message_index": target,
                              "context": context})

    @app.get("/api/practice/{cid}/{criterion_id}")
    def get_practice(cid: str, criterion_id: str, request: Request):
        role(request)
        with store.lock:
            current = exercise(cid, criterion_id)
            attempts = [a for a in store.data.get("practice_attempts", []) if a["exercise_key"] == current["exercise_key"]]
            return {**current, "attempts": copy.deepcopy(attempts[-20:]), "budget": store.budget()}

    @app.post("/api/practice/{cid}/{criterion_id}")
    def check_practice(cid: str, criterion_id: str, body: PracticeAnswer, request: Request):
        actor = role(request)
        answer = body.answer.strip()
        if not answer:
            raise HTTPException(422, "Напишите новый ответ для проверки.")
        request_id = str(body.request_id)
        with store.lock:
            current = exercise(cid, criterion_id)
            if body.exercise_key != current["exercise_key"] or body.evaluation_id != current["evaluation_id"]:
                raise HTTPException(409, "Оценка или правило изменились. Откройте упражнение заново.")
            signature = fingerprint({"exercise_key": body.exercise_key, "answer": answer, "language": body.language})
            receipts = store.data.get("practice_requests", {})
            receipt = receipts.get(request_id)
            if receipt and receipt["signature"] != signature:
                raise HTTPException(409, "Идентификатор попытки уже использован для другого ответа.")
            # Same answer and language always reuse saved feedback, including after a reload.
            previous = next((a for a in store.data.get("practice_attempts", []) if a["signature"] == signature), None)
            if previous:
                return {"attempt": copy.deepcopy(previous), "cached": True, "budget": store.budget()}
            if receipt:
                if receipt["status"] == "FAILED":
                    raise HTTPException(receipt["http_status"], receipt["error"])
                raise HTTPException(409, "Эта проверка уже запущена. Дождитесь результата или откройте упражнение заново.")
            if current["exercise_key"] in store.practice_active:
                raise HTTPException(409, "Упражнение уже проверяется. Дождитесь результата.")
            if not os.getenv("OPENAI_API_KEY"):
                raise HTTPException(503, "Проверка практики недоступна: ключ ИИ не настроен.")
            if store.budget()["remaining"] == 0:
                raise HTTPException(429, "Лимит проверок исчерпан.")
            ai_requests.require_external()
            ticket = ai_requests.consume(body.preview_id or request.headers.get("x-ai-preview"), actor, "practice",
                                         {"conversation_id": cid, "criterion_id": criterion_id, "answer": body.answer, "language": body.language})
            entry = ticket["entries"][0] if ticket["entries"] else None
            ai_requests.verify_entry(entry)
            store.data["budget"]["attempts"] += 1
            store.data.setdefault("practice_requests", {})[request_id] = {
                "signature": signature, "status": "RUNNING", "created_at": timestamp(),
            }
            store.event("practice_started", actor, conversation_id=cid, criterion_id=criterion_id,
                        evaluation_id=current["evaluation_id"], request_id=request_id)
            ai_requests.audit(actor, "practice", cid)
            store.save()
            store.practice_active.add(current["exercise_key"])
        usage = {}
        try:
            with ai_gateway.request_context(entry["prepared"], ai_requests.policy):
                raw = ai_coach.review(current, answer, body.language)
            usage = raw["usage"]
            with store.lock:
                # A new evaluation, edited transcript or appeal decision may arrive during the call.
                if exercise(cid, criterion_id)["exercise_key"] != current["exercise_key"]:
                    raise HTTPException(409, "Оценка или правило изменились. Откройте упражнение заново.")
                attempt = {"id": str(uuid.uuid4()), "conversation_id": cid, "criterion_id": criterion_id,
                           "exercise_key": current["exercise_key"], "evaluation_id": current["evaluation_id"],
                           "signature": signature, "answer": answer, "feedback_language": body.language,
                           "created_at": timestamp(), **raw}
                store.data.setdefault("practice_attempts", []).append(attempt)
                store.data["practice_requests"][request_id]["status"] = "COMPLETED"
                for k in ("prompt_tokens", "completion_tokens"):
                    store.data["budget"][k] += usage.get(k, 0)
                store.event("practice_completed", actor, conversation_id=cid, criterion_id=criterion_id,
                            attempt_id=attempt["id"], status=attempt["status"], usage=usage)
                store.save()
                return {"attempt": copy.deepcopy(attempt), "cached": False, "budget": store.budget()}
        except Exception as exc:
            usage = getattr(exc, "usage", usage)
            code = exc.status_code if isinstance(exc, HTTPException) else 502
            message = exc.detail if isinstance(exc, HTTPException) else "Не удалось проверить упражнение. Попытка учтена в лимите; ответ сохранён в форме."
            with store.lock:
                for k in ("prompt_tokens", "completion_tokens"):
                    store.data["budget"][k] += usage.get(k, 0)
                store.data["practice_requests"][request_id].update(status="FAILED", http_status=code, error=message)
                store.event("practice_failed", actor, conversation_id=cid, criterion_id=criterion_id,
                            request_id=request_id, error_type=type(exc).__name__, usage=usage)
                store.save()
            raise HTTPException(code, message) from None
        finally:
            with store.lock:
                store.practice_active.discard(current["exercise_key"])

    return exercise

"""Single-process local CQA API and frontend. Run from the repository root."""
import base64
import copy
import hashlib
import json
import os
import secrets
import threading
import uuid
from html.parser import HTMLParser
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from . import ai_evaluator
from .conversation_import import MAX_FILE_BYTES, extract_document, parse_transcript
from starlette.concurrency import run_in_threadpool
from .dataset import unpack_dataset
from .scoring_engine import Criterion, ChecklistUpdate, default_checklist, score_evaluation, validate_value

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


class MediaSourceParser(HTMLParser):
    """Extract only media URLs; organizer HTML is never executed or embedded."""
    def __init__(self):
        super().__init__()
        self.sources = []

    def handle_starttag(self, tag, attrs):
        if tag in ("source", "audio"):
            src = dict(attrs).get("src")
            if src:
                self.sources.append(src)


def cache_audio(url, destination):
    """Download one bounded recording so FileResponse can serve reliable byte ranges."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    upstream = None
    temporary = destination.with_suffix(".part")
    try:
        upstream = requests.get(url, stream=True, timeout=30, allow_redirects=False)
        if upstream.status_code != 200:
            raise ValueError("Аудио недоступно")
        content_type = upstream.headers.get("Content-Type", "application/octet-stream").lower()
        if "text/html" in content_type:
            # Read only a small HTML envelope, never a remote script.
            envelope_bytes = bytearray()
            for chunk in upstream.iter_content(16384):
                envelope_bytes.extend(chunk)
                if len(envelope_bytes) > 65536:
                    raise ValueError("Страница записи слишком велика")
            envelope = envelope_bytes.decode("utf-8", errors="replace")
            parser = MediaSourceParser(); parser.feed(envelope)
            upstream.close()
            media_url = parser.sources[0] if parser.sources else ""
            parsed = urlsplit(media_url)
            if parsed.scheme != "https" or parsed.hostname != "freedomholdingcorporation.crm11.dynamics.com" or parsed.username or parsed.password:
                raise ValueError("Неизвестный источник аудио")
            upstream = requests.get(media_url, stream=True, timeout=30, allow_redirects=False)
            if upstream.status_code != 200:
                raise ValueError("Аудио Dynamics недоступно")
            content_type = upstream.headers.get("Content-Type", "").lower()
        if "json" in content_type:
            # Alternate Power Automate binary response wrapper.
            raw = bytearray()
            for chunk in upstream.iter_content(65536):
                raw.extend(chunk)
                if len(raw) > 80 * 1024 * 1024:
                    raise ValueError("Запись слишком велика")
            payload = json.loads(raw)
            if not isinstance(payload, dict) or not isinstance(payload.get("$content"), str):
                raise ValueError("Ответ не содержит запись")
            media_type = payload.get("$content-type", "audio/mpeg")
            if not isinstance(media_type, str) or not (media_type.startswith("audio/") or media_type == "application/octet-stream"):
                raise ValueError("Неподдерживаемый формат записи")
            content = base64.b64decode(payload["$content"], validate=True)
            if len(content) > 60 * 1024 * 1024:
                raise ValueError("Запись слишком велика")
            temporary.write_bytes(content)
        else:
            if not (content_type.startswith("audio/") or "octet-stream" in content_type):
                raise ValueError("Неподдерживаемый формат записи")
            size = 0
            with temporary.open("wb") as file:
                for chunk in upstream.iter_content(65536):
                    size += len(chunk)
                    if size > 60 * 1024 * 1024:
                        raise ValueError("Запись слишком велика")
                    file.write(chunk)
        if not temporary.stat().st_size:
            raise ValueError("Пустая запись")
        os.replace(temporary, destination)
    finally:
        if upstream is not None:
            upstream.close()
        temporary.unlink(missing_ok=True)


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def semantic_hash(criteria):
    # Canonicalize numeric types/defaults before hashing round-tripped JSON.
    normalized = [Criterion(**c).model_dump() for c in criteria]
    return digest([{k: v for k, v in c.items() if k != "weight"} for c in normalized])


class StorageError(RuntimeError):
    """A failed commit; the in-memory state has been rolled back."""


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.active = set()
        self.audio_lock = threading.Lock()
        if self.path.exists():
            # Do not silently discard a damaged store, including budget reservations.
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        else:
            self.data = {"checklist": {"version": 1, "criteria": default_checklist()},
                         "dataset_group_id": "DEV", "records": {}, "evaluations": {},
                         "history": {}, "appeals": [], "audit": [],
                         "budget": {"attempts": 0, "prompt_tokens": 0, "completion_tokens": 0}}
        self._committed = copy.deepcopy(self.data)

    def save(self):
        temporary = self.path.with_suffix(".tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(self.data, ensure_ascii=False, indent=2, allow_nan=False)
            with temporary.open("w", encoding="utf-8") as file:
                file.write(payload)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        except (OSError, ValueError, TypeError):
            self.data = copy.deepcopy(self._committed)
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise StorageError("Не удалось сохранить изменения. Проверьте доступ к папке данных и свободное место.") from None
        self._committed = copy.deepcopy(self.data)

    def event(self, action, role, **details):
        self.data["audit"].append({"id": str(uuid.uuid4()), "timestamp": now(),
                                   "action": action, "role": role, **details})

    def archive(self, cid):
        if cid in self.data["evaluations"]:
            self.data["history"].setdefault(cid, []).append(copy.deepcopy(self.data["evaluations"][cid]))

    def supersede_appeals(self, cid=None):
        for a in self.data["appeals"]:
            if a["status"] == "PENDING" and (cid is None or a["conversation_id"] == cid):
                a.update(status="SUPERSEDED", resolved_at=now(), resolution_comment="Изменились правила или исходный диалог; создайте апелляцию после новой оценки.")

    def import_data(self, payload):
        group, records = unpack_dataset(payload)
        with self.lock:
            if self.active:
                raise HTTPException(409, "Дождитесь завершения оценки")
            uploaded = {cid: self.data["records"][cid] for cid in self.data.get("uploaded_ids", []) if cid in self.data["records"]}
            if any(r["conversation_id"] in uploaded for r in records):
                raise ValueError("Номер диалога группы совпал с загруженным диалогом")
            incoming = {r["conversation_id"] for r in records} | uploaded.keys()
            if len(incoming) > 5000:
                raise ValueError("Всего должно быть не больше 5000 диалогов")
            for removed in set(self.data["records"]) - incoming:
                self.supersede_appeals(removed)
            for r in records:
                cid = r["conversation_id"]
                previous = self.data["records"].get(cid)
                if previous and digest(previous) != digest(r):
                    self.supersede_appeals(cid)
            # Retain history and archived appeals across group changes.
            self.data["records"] = {**uploaded, **{r["conversation_id"]: copy.deepcopy(r) for r in records}}
            self.data["dataset_group_id"] = group
            self.event("dataset_imported", "supervisor", records=len(records), group=group)
            self.save()

    def status(self, cid):
        e = self.data["evaluations"].get(cid)
        if cid in self.active:
            return "Evaluating"
        if not e:
            return "Pending"
        if e["semantic_hash"] != semantic_hash(self.data["checklist"]["criteria"]) or e["transcript_hash"] != digest(self.data["records"][cid]):
            return "Stale"
        return "Evaluated"

    def budget(self):
        b = self.data["budget"]
        limit = max(0, int(os.getenv("OPENAI_MAX_CALLS", "3")))
        return {**b, "limit": limit, "remaining": max(0, limit - b["attempts"]),
                "configured": bool(os.getenv("OPENAI_API_KEY")), "model": os.getenv("OPENAI_MODEL", "gpt-4o")}


class SubmitAppeal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str
    criterion_id: str
    comment: str = Field(min_length=5, max_length=3000)
    evaluation_id: str


class ResolveAppeal(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    conversation_id: str
    criterion_id: str
    appeal_id: str
    action: Literal["APPROVED", "REJECTED"]
    new_score: float | None = Field(default=None, strict=True)
    is_na: bool = Field(default=False, strict=True)
    resolution_comment: str = Field(min_length=5, max_length=3000)


class ImportConversation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="Загруженный диалог", min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=100_000)
    language: Literal["RU", "KZ", "EN"]
    channel: Literal["agent chat", "voice call"] = "agent chat"


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_ids: list[str] = Field(min_length=1, max_length=65)


def create_app(store_path=None, dataset_file=None):
    app = FastAPI(title="Freedom CQA", version="1.0.0")
    store = Store(store_path or ROOT / os.getenv("DATA_STORE_PATH", "data/data_store.json"))
    app.state.store = store
    @app.exception_handler(StorageError)
    async def storage_error_handler(request, exc):
        return JSONResponse(status_code=503, content={"detail": str(exc)})
    source = Path(dataset_file or ROOT / os.getenv("DATASET_FILE", "data/dev_dataset.json"))
    if not store.data["records"] and source.exists():
        store.import_data(json.loads(source.read_text(encoding="utf-8-sig")))
    app.add_middleware(CORSMiddleware, allow_origins=[origin.strip() for origin in os.getenv(
        "CORS_ORIGINS", "http://127.0.0.1:8000,http://localhost:8000").split(",") if origin.strip()],
        allow_methods=["GET", "POST"], allow_headers=["Content-Type", "X-Role", "X-Supervisor-Token", "Range"],
        expose_headers=["Accept-Ranges", "Content-Range", "Content-Length"])

    def role(request, expected=None):
        value = request.headers.get("x-role", "operator")
        if value not in ("operator", "supervisor") or (expected and value != expected):
            raise HTTPException(403, "Действие недоступно для этой роли")
        token = os.getenv("QA_SUPERVISOR_TOKEN", "")
        if value == "supervisor" and token and not secrets.compare_digest(request.headers.get("x-supervisor-token", ""), token):
            raise HTTPException(403, "Нужен токен QA-супервизора")
        return value

    def get_record(cid):
        if cid not in store.data["records"]:
            raise HTTPException(404, "Диалог не найден")
        return store.data["records"][cid]

    @app.get("/api/health")
    def health():
        with store.lock:
            return {"status": "ok", "records": len(store.data["records"]), "budget": store.budget(),
                    "auth_mode": "supervisor-token" if os.getenv("QA_SUPERVISOR_TOKEN") else "local-demo"}

    @app.get("/api/conversations")
    def conversations(language: str | None = None, channel: str | None = None,
                      status: str | None = None, search: str = ""):
        with store.lock:
            items = []
            for cid, r in store.data["records"].items():
                current_status = store.status(cid)
                if language and r["language"] != language or channel and r["channel"] != channel or status and current_status != status:
                    continue
                if search and search.casefold() not in (cid + " " + r.get("title", "") + " " + " ".join(m["text"] for m in r["transcript"])).casefold():
                    continue
                e = store.data["evaluations"].get(cid)
                first = next((m["text"] for m in r["transcript"] if m["speaker"] == "client"), "Диалог")
                items.append({"id": cid, "title": r.get("title"), "language": r["language"], "channel": r["channel"], "preview": first,
                              "status": current_status, "score": e["final_score"] if e and current_status == "Evaluated" else None,
                              "has_gross_violation": bool(e and e["has_gross_violation"]),
                              "pending_appeals": sum(a["conversation_id"] == cid and a["status"] == "PENDING" for a in store.data["appeals"])})
            return {"items": items, "total": len(store.data["records"]), "group": store.data["dataset_group_id"],
                    "evaluated": sum(store.status(cid) == "Evaluated" for cid in store.data["records"]),
                    "budget": store.budget()}

    @app.post("/api/conversations/extract")
    async def extract(request: Request, filename: str = Query(min_length=1, max_length=240)):
        role(request, "supervisor")
        content = bytearray()
        async for chunk in request.stream():
            content.extend(chunk)
            if len(content) > MAX_FILE_BYTES:
                raise HTTPException(413, "Размер файла должен быть не больше 5 МБ.")
        try:
            text = await run_in_threadpool(extract_document, filename, bytes(content))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        return {"text": text}

    @app.post("/api/conversations/import", status_code=201)
    def import_conversation(body: ImportConversation, request: Request):
        role(request, "supervisor")
        try:
            transcript = parse_transcript(body.text)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        title = body.title.strip()
        if not title:
            raise HTTPException(422, "Укажите название диалога.")
        cid = "upload-" + uuid.uuid4().hex
        record = {"conversation_id": cid, "title": title, "language": body.language,
                  "channel": body.channel, "audio_url": None, "transcript": transcript}
        with store.lock:
            if len(store.data["records"]) >= 5000:
                raise HTTPException(409, "Достигнут лимит: 5000 диалогов.")
            store.data["records"] = {cid: record, **store.data["records"]}
            store.data.setdefault("uploaded_ids", []).append(cid)
            store.event("conversation_imported", "supervisor", conversation_id=cid, title=title,
                        messages=len(transcript))
            store.save()
        return {"id": cid, "messages": len(transcript)}

    @app.get("/api/conversations/{cid}")
    def conversation(cid: str):
        with store.lock:
            r = copy.deepcopy(get_record(cid))
            r["audio_url"] = f"/api/conversations/{cid}/audio?v={digest(r['audio_url'])[:16]}" if r.get("audio_url") else None
            return copy.deepcopy({**r, "status": store.status(cid), "evaluation": store.data["evaluations"].get(cid),
                    "appeals": [a for a in store.data["appeals"] if a["conversation_id"] == cid],
                    "history": store.data["history"].get(cid, [])})

    @app.get("/api/checklist")
    def checklist():
        with store.lock:
            return copy.deepcopy(store.data["checklist"])

    @app.post("/api/checklist")
    def update_checklist(body: ChecklistUpdate, request: Request):
        role(request, "supervisor")
        with store.lock:
            old = store.data["checklist"]
            if body.version != old["version"]:
                raise HTTPException(409, "Чек-лист уже изменён. Обновите страницу")
            if store.active:
                raise HTTPException(409, "Дождитесь завершения оценки")
            criteria = [c.model_dump() for c in body.criteria]
            changed = semantic_hash(criteria) != semantic_hash(old["criteria"])
            if criteria == old["criteria"]:
                return {**old, "requires_ai": False, "rescored": 0, "stale": 0}
            version = old["version"] + 1
            store.data["checklist"] = {"version": version, "criteria": criteria}
            count = 0
            for cid, e in store.data["evaluations"].items():
                if cid in store.data["records"] and e["semantic_hash"] == semantic_hash(criteria) and e["transcript_hash"] == digest(store.data["records"][cid]):
                    store.archive(cid)
                    e.update(score_evaluation(criteria, e["results"]), checklist_version=version, rescored_at=now())
                    count += 1
            if changed:
                store.supersede_appeals()
            store.event("checklist_updated", "supervisor", version=version, previous=old, current=copy.deepcopy(store.data["checklist"]), requires_ai=changed)
            store.save()
            return {**store.data["checklist"], "requires_ai": changed, "rescored": count,
                    "stale": sum(store.status(cid) == "Stale" for cid in store.data["records"])}

    def run_evaluation(cid, force=False):
        with store.lock:
            record = copy.deepcopy(get_record(cid))
            status = store.status(cid)
            if status == "Evaluated" and not force:
                return {"evaluation": store.data["evaluations"][cid], "cached": True, "budget": store.budget()}
            if store.active:
                raise HTTPException(409, "Уже выполняется оценка. Дождитесь завершения")
            if any(a["conversation_id"] == cid and a["status"] == "PENDING" for a in store.data["appeals"]):
                raise HTTPException(409, "Сначала разрешите ожидающие апелляции")
            if not os.getenv("OPENAI_API_KEY"):
                raise HTTPException(503, "OPENAI_API_KEY не настроен")
            if store.budget()["remaining"] == 0:
                raise HTTPException(429, "Лимит вызовов исчерпан. Изменение OPENAI_MAX_CALLS в .env требует осознанного решения и перезапуска сервера")
            config = copy.deepcopy(store.data["checklist"])
            # Reserve durably before network access; failed attempts also consume the ceiling.
            store.data["budget"]["attempts"] += 1
            store.event("evaluation_started", "supervisor", conversation_id=cid, checklist_version=config["version"])
            store.save()
            store.active.add(cid)
        usage = {}
        try:
            raw = ai_evaluator.evaluate(record, config["criteria"])
            usage = raw["usage"]
            evaluation = {**score_evaluation(config["criteria"], raw["results"]), "results": raw["results"],
                          "id": str(uuid.uuid4()), "created_at": now(), "checklist_version": config["version"],
                          "semantic_hash": semantic_hash(config["criteria"]), "transcript_hash": digest(record),
                          "source": "openai", "model": raw["model"], "usage": raw["usage"]}
            with store.lock:
                store.archive(cid)
                store.data["evaluations"][cid] = evaluation
                for key in ("prompt_tokens", "completion_tokens"):
                    store.data["budget"][key] += raw["usage"].get(key, 0)
                store.event("evaluation_completed", "supervisor", conversation_id=cid, evaluation_id=evaluation["id"], usage=raw["usage"])
                store.save()
                return {"evaluation": evaluation, "cached": False, "budget": store.budget()}
        except Exception as exc:
            with store.lock:
                usage = getattr(exc, "usage", usage)
                for key in ("prompt_tokens", "completion_tokens"):
                    store.data["budget"][key] += usage.get(key, 0)
                store.event("evaluation_failed", "supervisor", conversation_id=cid, error_type=type(exc).__name__, usage=usage)
                store.save()
            # Known evaluator errors have deliberately sanitized messages.
            detail = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else "Некорректный ответ ИИ; оценка не сохранена"
            raise HTTPException(503 if isinstance(exc, StorageError) else 502, detail) from None
        finally:
            with store.lock:
                store.active.discard(cid)

    @app.post("/api/evaluate/{cid}")
    def evaluate_one(cid: str, request: Request, force: bool = False):
        role(request, "supervisor")
        return run_evaluation(cid, force)

    @app.post("/api/evaluate-batch")
    def evaluate_batch(body: BatchRequest, request: Request):
        role(request, "supervisor")
        ids = list(dict.fromkeys(body.conversation_ids))
        with store.lock:
            if store.active:
                raise HTTPException(409, "Уже выполняется оценка. Дождитесь завершения")
            for cid in ids:
                get_record(cid)
                if store.status(cid) != "Evaluated" and any(a["conversation_id"] == cid and a["status"] == "PENDING" for a in store.data["appeals"]):
                    raise HTTPException(409, "Сначала рассмотрите ожидающие апелляции")
            need = sum(store.status(cid) != "Evaluated" for cid in ids)
            if need > store.budget()["remaining"]:
                raise HTTPException(429, "Пакет превышает оставшийся лимит. Выберите меньше диалогов")
        completed = []
        for cid in ids:
            try:
                result = run_evaluation(cid)
                completed.append({"id": cid, "cached": result["cached"]})
            except HTTPException as exc:
                return {"completed": completed, "stopped_at": cid, "error": exc.detail, "budget": store.budget()}
        return {"completed": completed, "budget": store.budget()}

    @app.post("/api/appeals/submit")
    def submit_appeal(body: SubmitAppeal, request: Request):
        role(request, "operator")
        with store.lock:
            get_record(body.conversation_id)
            e = store.data["evaluations"].get(body.conversation_id)
            if store.status(body.conversation_id) != "Evaluated" or not e or e["id"] != body.evaluation_id:
                raise HTTPException(409, "Оценка изменилась или неактуальна; обновите диалог")
            if body.criterion_id not in {r["criterion_id"] for r in e["results"]}:
                raise HTTPException(404, "Критерий не найден")
            if not body.comment.strip() or len(body.comment.strip()) < 5:
                raise HTTPException(422, "Поясните основание апелляции")
            if any(a["conversation_id"] == body.conversation_id and a["criterion_id"] == body.criterion_id and a["status"] == "PENDING" for a in store.data["appeals"]):
                raise HTTPException(409, "По критерию уже есть ожидающая апелляция")
            a = {**body.model_dump(), "id": str(uuid.uuid4()), "status": "PENDING", "created_at": now()}
            store.data["appeals"].append(a)
            store.event("appeal_submitted", "operator", appeal=copy.deepcopy(a))
            store.save()
            return a

    @app.post("/api/appeals/resolve")
    def resolve_appeal(body: ResolveAppeal, request: Request):
        role(request, "supervisor")
        with store.lock:
            get_record(body.conversation_id)
            a = next((a for a in store.data["appeals"] if a["id"] == body.appeal_id and a["conversation_id"] == body.conversation_id and a["criterion_id"] == body.criterion_id), None)
            if not a:
                raise HTTPException(404, "Апелляция не найдена")
            e = store.data["evaluations"].get(body.conversation_id)
            if a["status"] != "PENDING" or store.status(body.conversation_id) != "Evaluated" or not e or e["id"] != a["evaluation_id"]:
                raise HTTPException(409, "Апелляция уже рассмотрена или её оценка неактуальна")
            if len(body.resolution_comment.strip()) < 5:
                raise HTTPException(422, "Укажите причину решения")
            before = copy.deepcopy(e)
            if body.action == "APPROVED":
                c = next(c for c in store.data["checklist"]["criteria"] if c["id"] == body.criterion_id)
                try:
                    validate_value(c, body.new_score, body.is_na)
                except ValueError as exc:
                    raise HTTPException(422, str(exc)) from None
                store.archive(body.conversation_id)
                r = next(r for r in e["results"] if r["criterion_id"] == body.criterion_id)
                # Original AI reason/evidence remain intact; override reason is separate.
                r.update(value=body.new_score, is_na=body.is_na, override_comment=body.resolution_comment, overridden_at=now())
                e.update(score_evaluation(store.data["checklist"]["criteria"], e["results"]), updated_at=now())
            a.update(status=body.action, resolved_at=now(), resolution_comment=body.resolution_comment,
                     previous_score=before["final_score"], resulting_score=e["final_score"],
                     new_score=body.new_score if body.action == "APPROVED" else None,
                     is_na=body.is_na if body.action == "APPROVED" else False)
            store.event("appeal_resolved", "supervisor", appeal=copy.deepcopy(a), before=before, after=copy.deepcopy(e))
            store.save()
            return {"appeal": a, "evaluation": e}

    @app.get("/api/appeals")
    def appeals(request: Request):
        role(request)
        with store.lock:
            items = []
            for appeal in store.data["appeals"]:
                cid = appeal["conversation_id"]
                record = store.data["records"].get(cid)
                versions = [store.data["evaluations"].get(cid), *store.data["history"].get(cid, [])]
                evaluation = next((e for e in versions if e and e["id"] == appeal["evaluation_id"]), None)
                criterion = next((c for c in (evaluation or {}).get("criteria", [])
                                  if c["criterion_id"] == appeal["criterion_id"]), None)
                items.append({**appeal, "criterion_name": (criterion or {}).get("name", appeal["criterion_id"]),
                              "language": (record or {}).get("language"), "channel": (record or {}).get("channel"),
                              "conversation_available": record is not None})
            items.sort(key=lambda item: item["created_at"], reverse=True)
            return {"items": copy.deepcopy(items), "total": len(items),
                    "pending": sum(item["status"] == "PENDING" for item in items)}

    @app.get("/api/audit")
    def audit(request: Request, conversation_id: str | None = None):
        role(request, "supervisor")
        with store.lock:
            events = store.data["audit"]
            if conversation_id:
                events = [e for e in events if e.get("conversation_id") == conversation_id or e.get("appeal", {}).get("conversation_id") == conversation_id]
            return {"events": copy.deepcopy(events)}

    @app.post("/api/dataset/refresh")
    def refresh(request: Request, group_id: str = Query("DEV", pattern=r"^[A-Za-z0-9_-]{1,40}$")):
        role(request, "supervisor")
        endpoint = os.getenv("DATASET_URL", "")
        url = urlsplit(endpoint)
        if url.scheme != "https" or not (url.hostname or "").endswith(".api.powerplatform.com"):
            raise HTTPException(503, "Настройте DATASET_URL организаторов в .env")
        query = dict(parse_qsl(url.query)); query["group_id"] = group_id
        try:
            response = requests.get(urlunsplit(url._replace(query=urlencode(query))), timeout=45)
            response.raise_for_status()
            payload = response.json()
            store.import_data(payload)
        except (requests.RequestException, ValueError):
            raise HTTPException(502, "Не удалось загрузить корректный датасет организаторов; сохранён предыдущий") from None
        return {"group": store.data["dataset_group_id"], "records": len(store.data["records"])}

    @app.get("/api/conversations/{cid}/audio")
    def audio(cid: str):
        with store.lock:
            url = get_record(cid).get("audio_url")
        if not url:
            raise HTTPException(404, "Аудио отсутствует")
        destination = store.path.parent / "audio" / (digest(url) + ".mp3")
        try:
            with store.audio_lock:
                if not destination.exists():
                    cache_audio(url, destination)
            return FileResponse(destination, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=3600"})
        except (requests.RequestException, ValueError, KeyError):
            raise HTTPException(502, "Аудио временно недоступно; транскрипция сохранена") from None
        except OSError:
            raise HTTPException(503, "Не удалось сохранить запись. Проверьте свободное место.") from None

    app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")

    @app.get("/")
    def index():
        return FileResponse(ROOT / "frontend/index.html")

    return app


app = create_app()

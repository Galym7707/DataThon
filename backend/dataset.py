"""Organizer dataset validation without starting an app or opening its store."""
import re
from datetime import datetime
from urllib.parse import urlsplit


def canonical_group(group):
    return {"dev": "DEV", "fbroker": "FBroker", "swap": "SWAP"}.get(group.lower(), group)


def record_group(data, cid):
    return data.get("record_groups", {}).get(cid, "UPLOADED" if cid in data.get("uploaded_ids", []) else canonical_group(data.get("dataset_group_id", "DEV")))


def evaluation_enabled(data, cid):
    # The supplemental set is for viewing until its separate instructions arrive.
    return record_group(data, cid) != "SWAP"


def dataset_groups(data):
    groups = {}
    for cid in data.get("records", {}):
        group = record_group(data, cid)
        groups.setdefault(group, {"id": group, "total": 0, "evaluation_enabled": group != "SWAP"})["total"] += 1
    order = {"DEV": 0, "FBroker": 1, "SWAP": 2, "UPLOADED": 3}
    return sorted(groups.values(), key=lambda item: (order.get(item["id"], 4), item["id"]))


def scoped_data(data, group=None):
    if group is None:
        return data
    group = canonical_group(group)
    if group not in {item["id"] for item in dataset_groups(data)}:
        raise ValueError("Набор диалогов не найден")
    return {**data, "dataset_group_id": group,
            "records": {cid: record for cid, record in data["records"].items() if record_group(data, cid) == group}}


def valid_timestamp(value):
    if not isinstance(value, str):
        return False
    if "T" in value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
        except ValueError:
            return False
    return bool(re.fullmatch(r"(?:\d+:[0-5]\d|\d+):[0-5]\d(?:\.\d+)?", value))


def unpack_dataset(payload):
    if not isinstance(payload, dict) or payload.get("isSuccess") is not True:
        raise ValueError("Ожидался успешный ответ организаторов")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("Не найден список диалогов")
    records = data.get("records")
    if not isinstance(records, list) or not records or len(records) > 5000:
        raise ValueError("Пустой или некорректный список диалогов")
    seen = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("Некорректный диалог")
        cid = record.get("conversation_id")
        if not isinstance(cid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", cid) or cid in seen:
            raise ValueError("Некорректный или повторяющийся номер диалога")
        seen.add(cid)
        if record.get("language") not in ("RU", "KZ", "EN") or record.get("channel") not in ("agent chat", "voice call"):
            raise ValueError("Неподдерживаемый язык или канал")
        transcript = record.get("transcript")
        if not isinstance(transcript, list) or not transcript:
            raise ValueError("Нужна непустая переписка")
        for message in transcript:
            if not isinstance(message, dict) or message.get("speaker") not in ("client", "operator", "bot", "system"):
                raise ValueError("Некорректная реплика")
            if not isinstance(message.get("text"), str) or not valid_timestamp(message.get("timestamp")):
                raise ValueError("Некорректный текст или время реплики")
        audio = record.get("audio_url")
        if audio is not None:
            if not isinstance(audio, str):
                raise ValueError("Некорректная ссылка на запись")
            parsed = urlsplit(audio)
            if parsed.scheme != "https" or not (parsed.hostname or "").endswith(".api.powerplatform.com") or parsed.username or parsed.password:
                raise ValueError("Запись должна находиться на сервере организаторов")
    total = data.get("total_records", len(records))
    if type(total) is not int or total != len(records):
        raise ValueError("Количество диалогов не совпадает со списком")
    group = data.get("dataset_group_id", "DEV")
    if not isinstance(group, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", group):
        raise ValueError("Некорректное название группы")
    return canonical_group(group), records

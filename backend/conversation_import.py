"""Local document extraction and explicit speaker parsing. No model calls."""
import io
import json
import re
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree
from pypdf import PdfReader
from .dataset import valid_timestamp

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TEXT_CHARS = 100_000
SPEAKERS = {"клиент": "client", "client": "client", "customer": "client",
            "оператор": "operator", "operator": "operator", "agent": "operator",
            "бот": "bot", "bot": "bot", "система": "system", "system": "system"}
LINE = re.compile(r"^\s*(?:(?:\[(?P<bracket>[^\]]{1,40})\]|(?P<time>\d{1,3}:[0-5]\d(?::[0-5]\d)?))\s+)?"
                  r"(?P<speaker>" + "|".join(SPEAKERS) + r")\s*[:—–-]\s*(?P<text>.*)$", re.IGNORECASE)


class DocumentError(ValueError):
    pass


def extract_document(filename, content):
    if not content or len(content) > MAX_FILE_BYTES:
        raise DocumentError("Выберите непустой файл размером до 5 МБ.")
    suffix = PurePosixPath(filename.replace("\\", "/")).suffix.lower()
    try:
        if suffix == ".txt":
            if content.startswith((b"\xff\xfe", b"\xfe\xff")):
                text = content.decode("utf-16")
            else:
                try:
                    text = content.decode("utf-8-sig")
                except UnicodeDecodeError:
                    text = content.decode("cp1251")
            if "\x00" in text:
                raise DocumentError("Не удалось прочитать текстовый файл. Сохраните его в UTF-8.")
        elif suffix == ".docx":
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                if sum(item.file_size for item in archive.infolist()) > 20 * 1024 * 1024:
                    raise DocumentError("Документ слишком большой после распаковки. Сохраните его как TXT.")
                xml = archive.read("word/document.xml")
            root = ElementTree.fromstring(xml)
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            word = "{" + ns["w"] + "}"
            text = "\n".join("".join((node.text or "") if node.tag == word + "t" else "\n" if node.tag in (word + "br", word + "cr") else "\t" if node.tag == word + "tab" else ""
                                      for node in p.iter()) for p in root.findall(".//w:p", ns))
        elif suffix == ".pdf":
            reader = PdfReader(io.BytesIO(content))
            if reader.is_encrypted:
                raise DocumentError("PDF защищён паролем. Сохраните копию без пароля.")
            if len(reader.pages) > 50:
                raise DocumentError("В PDF должно быть не больше 50 страниц.")
            parts = []
            for page in reader.pages:
                parts.append(page.extract_text() or "")
                if sum(map(len, parts)) > MAX_TEXT_CHARS:
                    raise DocumentError("Текст слишком длинный: максимум 100 000 символов.")
            text = "\n".join(parts)
            if not text.strip():
                raise DocumentError("В PDF нет текста. Вставьте расшифровку или выберите документ с текстом.")
        else:
            raise DocumentError("Поддерживаются файлы TXT, DOCX, PDF с текстом и JSON.")
    except DocumentError:
        raise
    except Exception:
        raise DocumentError("Не удалось прочитать документ. Проверьте формат файла.") from None
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text or len(text) > MAX_TEXT_CHARS:
        raise DocumentError("Нужен непустой текст длиной до 100 000 символов.")
    return text


def parse_transcript(text):
    if not text.strip() or len(text) > MAX_TEXT_CHARS:
        raise ValueError("Нужен непустой текст длиной до 100 000 символов.")
    messages = []
    for line_number, line in enumerate(text.lstrip("\ufeff").splitlines(), 1):
        if not line.strip():
            continue
        match = LINE.match(line)
        if match:
            timestamp = match["bracket"] or match["time"]
            if timestamp and not valid_timestamp(timestamp):
                raise ValueError(f"Строка {line_number}: время укажите как 00:15 или 01:02:15.")
            messages.append({"speaker": SPEAKERS[match["speaker"].lower()], "text": match["text"].strip(),
                             "timestamp": timestamp or f"Реплика {len(messages) + 1}"})
        elif messages:
            messages[-1]["text"] += "\n" + line.strip()
        else:
            raise ValueError(f"Строка {line_number}: начните реплику с «Клиент:» или «Оператор:».")
        if len(messages) > 2000:
            raise ValueError("В одном диалоге должно быть не больше 2000 реплик.")
    if any(not m["text"].strip() for m in messages):
        raise ValueError("После имени участника нужен текст реплики.")
    if not {"client", "operator"}.issubset({m["speaker"] for m in messages}):
        raise ValueError("Нужны реплики клиента и оператора. Подпишите их «Клиент:» и «Оператор:».")
    return messages


def normalize_messages(messages):
    """Accept explicit roles and evidence only, never scores or instructions."""
    if not isinstance(messages, list) or not 2 <= len(messages) <= 2000:
        raise DocumentError("В диалоге должно быть от 2 до 2000 реплик.")
    result = []
    total = 0
    for i, message in enumerate(messages, 1):
        if not isinstance(message, dict):
            raise DocumentError(f"Реплика {i}: нужен объект с участником и текстом.")
        speaker = message.get("speaker", message.get("role"))
        speaker = SPEAKERS.get(speaker.lower()) if isinstance(speaker, str) else None
        text = message.get("text", message.get("content"))
        if not speaker:
            raise DocumentError(f"Реплика {i}: участник должен быть client, operator, bot или system.")
        if not isinstance(text, str) or not text.strip():
            raise DocumentError(f"Реплика {i}: нужен непустой текст.")
        total += len(text)
        if total > MAX_TEXT_CHARS:
            raise DocumentError("Текст одного диалога не должен превышать 100 000 символов.")
        timestamp = message.get("timestamp")
        if timestamp is None or timestamp == "":
            timestamp = f"Реплика {i}"
        if not valid_timestamp(timestamp) and timestamp != f"Реплика {i}":
            raise DocumentError(f"Реплика {i}: некорректное время. Используйте 00:15 или дату со временем и часовым поясом.")
        result.append({"speaker": speaker, "text": text, "timestamp": timestamp})
    if not {"client", "operator"}.issubset({m["speaker"] for m in result}):
        raise DocumentError("Нужны реплики клиента и оператора: client и operator.")
    return result


def transcript_text(messages):
    names = {"client": "Клиент", "operator": "Оператор", "bot": "Бот", "system": "Система"}
    return "\n".join((f'[{m["timestamp"]}] ' if valid_timestamp(m["timestamp"]) else '') +
                      names[m["speaker"]] + ": " + m["text"] for m in messages)


def extract_json(content):
    if not content or len(content) > MAX_FILE_BYTES:
        raise DocumentError("Выберите непустой файл размером до 5 МБ.")
    try:
        payload = json.loads(content)
    except (ValueError, UnicodeError, RecursionError):
        raise DocumentError("Не удалось прочитать JSON. Проверьте скобки, запятые и кодировку файла.") from None
    data = payload
    if isinstance(data, dict) and "data" in data and "records" not in data and "transcript" not in data and "messages" not in data:
        if data.get("isSuccess") is False:
            raise DocumentError("В JSON указан неуспешный ответ. Выберите файл с диалогами.")
        data = data["data"]
    if isinstance(data, dict) and "records" in data:
        data = data["records"]
    if isinstance(data, dict):
        records = [data]
    elif isinstance(data, list) and data and all(isinstance(m, dict) and ("speaker" in m or "role" in m) for m in data):
        records = [{"transcript": data}]
    else:
        records = data
    if not isinstance(records, list) or not 1 <= len(records) <= 5000:
        raise DocumentError("Нужен JSON с одним диалогом или списком диалогов (не больше 5000).")
    result = []
    for i, record in enumerate(records, 1):
        if not isinstance(record, dict):
            raise DocumentError(f"Диалог {i}: нужен объект с полем transcript или messages.")
        try:
            messages = record.get("transcript", record.get("messages"))
            if messages is None and isinstance(record.get("text"), str):
                messages = parse_transcript(record["text"])
            messages = normalize_messages(messages)
            title = record.get("title", record.get("conversation_id", f"Диалог {i}"))
            if not isinstance(title, str) or not title.strip() or len(title) > 120:
                raise DocumentError("Название должно быть строкой длиной от 1 до 120 символов.")
            language = record.get("language")
            if language is not None and language not in ("RU", "KZ", "EN"):
                raise DocumentError("Язык должен быть RU, KZ или EN.")
            channel = record.get("channel", "agent chat")
            if channel not in ("agent chat", "voice call"):
                raise DocumentError("Канал должен быть agent chat или voice call.")
        except ValueError as exc:
            raise DocumentError(f"Диалог {i}: {exc}") from None
        result.append({"title": title.strip(), "language": language, "channel": channel,
                       "transcript": messages, "text": transcript_text(messages)})
    return result


def extract_upload(filename, content):
    if PurePosixPath(filename.replace("\\", "/")).suffix.lower() == ".json":
        return {"conversations": extract_json(content)}
    return {"text": extract_document(filename, content)}

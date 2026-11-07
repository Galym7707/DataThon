"""Local document extraction and explicit speaker parsing. No model calls."""
import io
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
            raise DocumentError("Поддерживаются файлы TXT, DOCX и PDF с текстом.")
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

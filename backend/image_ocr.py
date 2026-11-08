"""Offline screenshot/photo extraction using macOS Vision, without model calls.

No roles, timestamps or content are inferred. The user reviews and labels the
recognized text in the existing import editor before saving a conversation.
"""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import threading


ROOT = Path(__file__).resolve().parent.parent
_recognition_slot = threading.BoundedSemaphore(1)


def _recognizer():
    if platform.system() != "Darwin":
        raise ValueError("Распознавание фото доступно на macOS. Вставьте текст диалога вручную.")
    source = ROOT / "scripts" / "recognize_image.swift"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    binary = ROOT / "output" / ("image-ocr-" + digest)
    if not binary.exists():
        binary.parent.mkdir(parents=True, exist_ok=True)
        try:
            result = subprocess.run(
                ["/usr/bin/xcrun", "swiftc", "-O", str(source), "-o", str(binary)],
                capture_output=True, timeout=120, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise ValueError("Не удалось подготовить распознавание фото. Вставьте текст вручную.") from None
        if result.returncode:
            binary.unlink(missing_ok=True)
            raise ValueError("Для распознавания фото нужны инструменты разработчика macOS. Вставьте текст вручную.")
    return binary


def recognize_image(content):
    if not _recognition_slot.acquire(blocking=False):
        raise ValueError("Уже распознаётся другое фото. Подождите и повторите загрузку.")
    try:
        binary = _recognizer()
        try:
            result = subprocess.run([str(binary)], input=content, capture_output=True,
                                    timeout=45, check=False)
            response = json.loads(result.stdout)
        except subprocess.TimeoutExpired:
            raise ValueError("Распознавание заняло слишком много времени. Выберите более чёткое фото или вставьте текст.") from None
        except (OSError, ValueError):
            raise ValueError("Не удалось распознать фото. Выберите другое изображение или вставьте текст.") from None
        if response.get("error") == "invalid_image":
            raise ValueError("Не удалось прочитать изображение. Выберите PNG, JPG или WebP до 24 мегапикселей.")
        if result.returncode or response.get("error"):
            raise ValueError("Не удалось распознать фото. Выберите другое изображение или вставьте текст.")
        text = response.get("text", "").strip()
        if not text:
            raise ValueError("На изображении не найден текст. Загрузите чёткий скриншот переписки.")
        if len(text) > 100_000:
            raise ValueError("Текст слишком длинный: максимум 100 000 символов.")
        return {"text": text, "source": "image", "ocr": {
            "engine": "Apple Vision", "languages": response.get("languages", []),
            "review_required": True,
        }}
    finally:
        _recognition_slot.release()

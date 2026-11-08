"""Image import is offline, reviewable, bounded and never consumes AI budget."""
from pathlib import Path
import platform
import subprocess

import pytest
from fastapi.testclient import TestClient

from backend import image_ocr
from backend.conversation_import import extract_upload, MAX_FILE_BYTES, parse_transcript
from backend.main import create_app


IMAGE = Path(__file__).parent / "fixtures" / "chat-ocr.png"
HEADERS = {"X-Role": "supervisor"}


@pytest.mark.parametrize("extension", ["png", "JPG", "jpeg", "webp"])
def test_image_upload_dispatches_without_saving_or_evaluating(tmp_path, monkeypatch, extension):
    monkeypatch.delenv("QA_SUPERVISOR_TOKEN", raising=False)
    calls = []
    def fake_ocr(content):
        calls.append(content)
        return {"text": "Client: Hello\nOperator: Welcome", "source": "image",
                "ocr": {"engine": "Apple Vision", "review_required": True}}
    monkeypatch.setattr(image_ocr, "recognize_image", fake_ocr)
    app = create_app(tmp_path / "store.json", tmp_path / "absent.json")
    client = TestClient(app)
    before = client.get("/api/health").json()
    endpoint = f"/api/conversations/extract?filename=chat.{extension}"
    assert client.post(endpoint, content=b"image").status_code == 403
    result = client.post(endpoint, headers=HEADERS, content=b"image")
    assert result.status_code == 200
    assert result.json()["ocr"]["review_required"] is True
    assert calls == [b"image"]
    assert client.get("/api/health").json() == before
    # Saving is a separate explicit step, preserving the edited evidence exactly.
    saved = client.post("/api/conversations/import", headers=HEADERS, json={
        "title": "Screenshot", "language": "EN",
        "text": result.json()["text"].replace("Welcome", "Welcome back"),
    })
    assert saved.status_code == 201
    record = client.get("/api/conversations/" + saved.json()["id"]).json()
    assert record["transcript"][1]["text"] == "Welcome back"
    assert record["evaluation"] is None
    assert client.get("/api/health").json()["budget"] == before["budget"]


def test_invalid_sizes_never_enter_ocr(monkeypatch):
    monkeypatch.setattr(image_ocr, "recognize_image", lambda *_: pytest.fail("Invalid size reached OCR"))
    for content in (b"", b"x" * (MAX_FILE_BYTES + 1)):
        with pytest.raises(ValueError, match="5 МБ"):
            extract_upload("photo.png", content)


def test_kazakh_speaker_labels_preserve_content():
    result = parse_transcript("Тұтынушы: Сәлеметсіз бе!\nМаман: Қайырлы күн!\nЖүйе: Аяқталды")
    assert [row["speaker"] for row in result] == ["client", "operator", "system"]
    assert result[0]["text"] == "Сәлеметсіз бе!"


def test_timeout_releases_recognition_slot(monkeypatch):
    monkeypatch.setattr(image_ocr, "_recognizer", lambda: "/unused")
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 45)
    monkeypatch.setattr(image_ocr.subprocess, "run", timeout)
    for _ in range(2):
        with pytest.raises(ValueError, match="слишком много времени"):
            image_ocr.recognize_image(b"image")


def test_parallel_recognition_is_bounded():
    assert image_ocr._recognition_slot.acquire(blocking=False)
    try:
        with pytest.raises(ValueError, match="другое фото"):
            image_ocr.recognize_image(b"image")
    finally:
        image_ocr._recognition_slot.release()


@pytest.mark.skipif(platform.system() != "Darwin", reason="Apple Vision requires macOS")
def test_real_offline_ocr_and_malformed_image():
    result = extract_upload("chat.png", IMAGE.read_bytes())
    assert "Где мой тариф?" in result["text"]
    assert "Откройте кабинет." in result["text"]
    assert len(parse_transcript(result["text"])) == 2
    assert result["ocr"]["review_required"] is True
    with pytest.raises(ValueError, match="прочитать изображение"):
        extract_upload("broken.png", b"not an image")

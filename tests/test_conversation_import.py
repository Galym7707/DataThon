"""Document import must preserve evidence, existing records and the paid budget."""
import io
import json
import zipfile
import pytest
from preview_client import PreviewClient as TestClient
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from backend.conversation_import import extract_document, parse_transcript, MAX_FILE_BYTES
from backend.main import create_app

SUPERVISOR = {"X-Role": "supervisor"}
TEXT = "Клиент: Где мой тариф?\nОператор: Откройте кабинет.\nКлиент: Спасибо."


@pytest.fixture
def importer(tmp_path, monkeypatch):
    monkeypatch.delenv("QA_SUPERVISOR_TOKEN", raising=False)
    app = create_app(tmp_path / "store.json", tmp_path / "missing.json")
    record = {"conversation_id": "original", "language": "RU", "channel": "agent chat",
              "transcript": [{"speaker": "client", "text": "Question", "timestamp": "00:00"}]}
    payload = {"isSuccess": True, "data": {"records": [record], "dataset_group_id": "TEST"}}
    app.state.store.import_data(payload)
    return TestClient(app), payload


def docx_bytes():
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as archive:
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Client: Question</w:t></w:r></w:p><w:p><w:r><w:t>Agent: Answer</w:t></w:r></w:p></w:body></w:document>')
    return result.getvalue()


def pdf_bytes(text=True):
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=800)
    if text:
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 50 750 Td (Client: Question) Tj 0 -20 Td (Agent: Answer) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
    result = io.BytesIO();writer.write(result)
    return result.getvalue()


def test_parse_preserves_real_times_multiline_and_context():
    rows = parse_transcript("[00:01] Клиент: Вопрос\nПродолжение\n00:04 Бот: Уточняю.\n[00:07] Оператор: Ответ")
    assert rows[0] == {"speaker": "client", "text": "Вопрос\nПродолжение", "timestamp": "00:01"}
    assert rows[1]["speaker"] == "bot" and rows[2]["timestamp"] == "00:07"


def test_missing_times_are_numbers_not_invented_seconds():
    rows = parse_transcript(TEXT)
    assert [m["timestamp"] for m in rows] == ["Реплика 1", "Реплика 2", "Реплика 3"]


@pytest.mark.parametrize("text", ["Неизвестный участник: привет", "Клиент: один", "Клиент:\nОператор: Ответ", "[00:99] Клиент: вопрос\nОператор: ответ"])
def test_ambiguous_or_empty_messages_rejected(text):
    with pytest.raises(ValueError): parse_transcript(text)


@pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16", "cp1251"])
def test_text_encodings_preserve_russian(encoding):
    assert extract_document("dialog.txt", TEXT.encode(encoding)) == TEXT


def test_docx_and_pdf_extract_real_text():
    assert len(parse_transcript(extract_document("dialog.docx", docx_bytes()))) == 2
    assert len(parse_transcript(extract_document("dialog.pdf", pdf_bytes()))) == 2


def test_scan_and_corrupt_document_give_readable_errors():
    with pytest.raises(ValueError, match="В PDF нет текста"):
        extract_document("scan.pdf", pdf_bytes(False))
    with pytest.raises(ValueError, match="Не удалось прочитать документ"):
        extract_document("bad.docx", b"bad zip")
    with pytest.raises(ValueError, match="Поддерживаются файлы"):
        extract_document("bad.exe", b"bad")


def test_import_appends_selectable_conversation_and_never_evaluates(importer, monkeypatch):
    client, payload = importer
    def forbidden(*args): raise AssertionError("Import must not call the evaluator")
    monkeypatch.setattr("backend.ai_evaluator.evaluate", forbidden)
    before = client.get("/api/health").json()["budget"]
    response = client.post("/api/conversations/import", headers=SUPERVISOR,
                           json={"title": "Новый диалог", "language": "KZ", "text": TEXT})
    assert response.status_code == 201
    cid = response.json()["id"]
    record = client.get(f"/api/conversations/{cid}").json()
    assert record["title"] == "Новый диалог" and record["language"] == "KZ"
    assert client.get("/api/conversations", params={"search": "Новый диалог"}).json()["items"][0]["id"] == cid
    assert record["status"] == "Pending" and record["evaluation"] is None
    assert client.get("/api/conversations/original").status_code == 200
    assert client.get("/api/health").json()["budget"] == before
    # Refreshing an organizer group must retain uploaded conversations, including after reload.
    store = client.app.state.store
    reloaded = create_app(store.path, store.path.parent / "missing.json")
    reloaded.state.store.import_data(payload)
    assert cid in reloaded.state.store.data["records"]


def test_import_validation_access_and_failed_save_preserve_store(importer, monkeypatch):
    client, _ = importer
    body = {"title": "Диалог", "language": "RU", "text": TEXT}
    assert client.post("/api/conversations/import", json=body).status_code == 403
    assert client.post("/api/conversations/import", json={**body, "text": "Текст без ролей"}, headers=SUPERVISOR).status_code == 422
    store = client.app.state.store
    monkeypatch.setattr("backend.main.os.replace", lambda *args: (_ for _ in ()).throw(OSError("disk full")))
    assert client.post("/api/conversations/import", json=body, headers=SUPERVISOR).status_code == 503
    assert list(store.data["records"]) == ["original"]
    assert not store.data.get("uploaded_ids")


def test_upload_endpoint_size_roles_and_preview_do_not_store(importer):
    client, _ = importer
    assert client.post("/api/conversations/extract?filename=x.txt", content=TEXT.encode()).status_code == 403
    response = client.post("/api/conversations/extract?filename=x.docx", content=docx_bytes(), headers=SUPERVISOR)
    assert response.status_code == 200 and "Client:" in response.json()["text"]
    assert client.get("/api/health").json()["records"] == 1
    response = client.post("/api/conversations/extract?filename=x.txt", content=b"x"*(MAX_FILE_BYTES+1), headers=SUPERVISOR)
    assert response.status_code == 413


def test_import_accepts_evaluation_with_explicit_reply_references(importer, monkeypatch):
    from backend.ai_evaluator import validate_evidence
    from backend.scoring_engine import default_checklist
    client, _ = importer
    cid = client.post("/api/conversations/import", headers=SUPERVISOR,
                      json={"title": "Test", "language": "RU", "text": TEXT}).json()["id"]
    transcript = client.get(f"/api/conversations/{cid}").json()["transcript"]
    criteria = default_checklist()
    results = [{"criterion_id": c["id"], "value": 0, "is_na": False, "reason": "Test",
                "proof_quote": transcript[0]["text"], "proof_timestamp": "Реплика 1", "proof_message_index": 0} for c in criteria]
    assert validate_evidence(results, criteria, transcript) == results
    def fake_evaluate(record, configured):
        assert record["transcript"] == transcript
        return {"results": results, "model": "mock-no-network", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
    monkeypatch.setattr("backend.ai_evaluator.evaluate", fake_evaluate)
    response = client.post(f"/api/evaluate/{cid}", headers=SUPERVISOR)
    assert response.status_code == 200
    assert response.json()["evaluation"]["criteria"][0]["proof_timestamp"] == "Реплика 1"
    assert client.get(f"/api/conversations/{cid}").json()["status"] == "Evaluated"


JSON_MESSAGES = [{"speaker": "client", "text": "Вопрос\nОператор: это цитата клиента", "timestamp": "2026-11-07T10:00:00Z"},
                 {"speaker": "operator", "text": "Ответ", "timestamp": "2026-11-07T10:00:07Z"}]


@pytest.mark.parametrize("shape", ["single", "list", "records", "organizer", "messages", "text"])
def test_json_file_shapes_and_evidence_preservation(shape):
    from backend.conversation_import import extract_upload
    record = {"conversation_id": "json-test", "language": "KZ", "transcript": JSON_MESSAGES,
              "evaluation": {"final_score": 100}, "audio_url": "https://example.com/ignored.mp3"}
    data = {"single": record, "list": [record], "records": {"records": [record]},
            "organizer": {"isSuccess": True, "data": {"records": [record]}},
            "messages": [{"role": "client", "content": "Question"}, {"role": "agent", "content": "Answer"}],
            "text": {"text": TEXT}}[shape]
    result = extract_upload("dialog.JSON", json.dumps(data, ensure_ascii=False).encode("utf-8-sig"))["conversations"]
    assert len(result) == 1 and "evaluation" not in result[0] and "audio_url" not in result[0]
    if shape in ("single", "list", "records", "organizer"):
        assert result[0]["transcript"] == JSON_MESSAGES
        assert result[0]["language"] == "KZ"
    else:
        assert result[0]["transcript"][0]["timestamp"] == "Реплика 1"


@pytest.mark.parametrize("content", [b"{bad json", b"[]", b"42", b'{"isSuccess":false,"data":{"records":[]}}',
    b'{"transcript":[{"speaker":"assistant","text":"Hello"},{"speaker":"client","text":"Hi"}]}',
    b'{"transcript":[{"speaker":"operator","text":42},{"speaker":"client","text":"Hi"}]}'])
def test_invalid_json_is_rejected_without_guessing_roles(content):
    from backend.conversation_import import extract_json
    with pytest.raises(ValueError): extract_json(content)


def test_structured_json_import_retains_exact_replies_and_discards_scores(importer, monkeypatch):
    client, _ = importer
    monkeypatch.setattr("backend.ai_evaluator.evaluate", lambda *args: pytest.fail("No paid evaluation on import"))
    before = client.get("/api/health").json()["budget"]
    response = client.post("/api/conversations/extract?filename=dialog.json", headers=SUPERVISOR,
        content=json.dumps({"title": "JSON диалог", "language": "EN", "transcript": JSON_MESSAGES,
                            "evaluation": {"final_score": 100}}).encode())
    assert response.status_code == 200
    item = response.json()["conversations"][0]
    result = client.post("/api/conversations/import", headers=SUPERVISOR,
        json={k:item[k] for k in ("title", "language", "channel", "transcript")})
    assert result.status_code == 201
    stored = client.get('/api/conversations/'+result.json()["id"]).json()
    assert stored["transcript"] == JSON_MESSAGES
    assert stored["evaluation"] is None and stored["audio_url"] is None
    assert client.get("/api/health").json()["budget"] == before


def test_json_message_validation_and_unambiguous_import_request(importer):
    from backend.conversation_import import normalize_messages
    client, _ = importer
    bad = [{"speaker": "client", "text": "Question", "timestamp": "00:99"}, {"speaker": "operator", "text": "Answer"}]
    with pytest.raises(ValueError): normalize_messages(bad)
    assert client.post("/api/conversations/import", headers=SUPERVISOR,
        json={"language": "RU", "text": TEXT, "transcript": JSON_MESSAGES}).status_code == 422
    assert client.post("/api/conversations/import", headers=SUPERVISOR,
        json={"language": "RU", "transcript": bad}).status_code == 422
    assert client.get("/api/health").json()["records"] == 1

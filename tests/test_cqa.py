"""Deterministic tests. Network evaluators are replaced; no paid API calls."""
import copy
import json
import pytest
from fastapi.testclient import TestClient
from backend.main import create_app, cache_audio
from backend.scoring_engine import default_checklist, score_evaluation, ChecklistUpdate
from backend.ai_evaluator import validate_evidence, response_schema, EvaluationValidationError

SUPERVISOR = {"X-Role": "supervisor"}
OPERATOR = {"X-Role": "operator"}


def results(criteria=None):
    return [{"criterion_id": c["id"], "value": 0 if c["type"] == "flag" else c["max_scale"],
             "is_na": False, "reason": "Обоснование по тестовой реплике", "proof_quote": "Здравствуйте",
             "proof_timestamp": "00:02", "proof_message_index": 1}
            for c in (criteria or default_checklist())]


def test_weight_redistribution_and_discrete_scales():
    r = results()
    for item in r:
        if item["criterion_id"] in ("02", "03"):
            item.update(value=None, is_na=True)
        elif item["criterion_id"] == "04":
            item["value"] = 10
        elif item["criterion_id"] == "06":
            item["value"] = 7
    e = score_evaluation(default_checklist(), r)
    assert e["applicable_weight"] == 65
    assert e["final_score"] == 77.69  # (10 + 10 + 15 + 10.5 + 5) / 65 * 100
    assert sum(x["normalized_weight"] for x in e["criteria"]) == pytest.approx(100)


def test_flag_does_not_zero_score_and_zero_weight_is_null():
    r = results(); r[-1]["value"] = 1
    e = score_evaluation(default_checklist(), r)
    assert e["final_score"] == 100 and e["has_gross_violation"]
    c = default_checklist()
    for item in c:
        item["weight"] = 0
    assert score_evaluation(c, r)["final_score"] is None


@pytest.mark.parametrize("index,patch", [(0,{"value":None,"is_na":True}),(5,{"value":5}),(1,{"value":None}),(0,{"value":True})])
def test_invalid_values_rejected(index, patch):
    r = results(); r[index].update(patch)
    with pytest.raises(ValueError):
        score_evaluation(default_checklist(), r)


def test_missing_or_duplicate_criteria_rejected():
    with pytest.raises(ValueError):
        score_evaluation(default_checklist(), results()[:-1])
    with pytest.raises(ValueError):
        score_evaluation(default_checklist(), results() + [results()[0]])


@pytest.mark.parametrize("patch", [{"proof_quote":"Выдуманная цитата"},{"proof_timestamp":"10:00"},{"proof_message_index":99}])
def test_fabricated_evidence_rejected(patch):
    r = results(); r[0].update(patch)
    with pytest.raises(ValueError):
        validate_evidence(r, default_checklist(), [{"text":"Вопрос","timestamp":"00:00"},{"text":"Здравствуйте!","timestamp":"00:02"}])


def test_schema_prevents_invalid_na_and_missing_criteria():
    import jsonschema
    schema=response_schema(default_checklist())
    payload={"results":{r["criterion_id"]:r for r in results()}}
    jsonschema.validate(payload,schema)
    for cid,value in (("01",None),("02",0)):
        invalid=copy.deepcopy(payload)
        invalid['results'][cid].update(is_na=True,value=value)
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(invalid,schema)
    missing=copy.deepcopy(payload); missing['results'].pop('01')
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(missing,schema)


def test_evaluator_uses_strict_schema_and_parses_keyed_results(monkeypatch):
    from types import SimpleNamespace
    from backend import ai_evaluator
    monkeypatch.setenv('OPENAI_API_KEY','test-placeholder')
    captured={}
    def create(**kwargs):
        captured.update(kwargs)
        payload={'results':{r['criterion_id']:r for r in results()}}
        return SimpleNamespace(model='mock-gpt-4o',usage=SimpleNamespace(prompt_tokens=12,completion_tokens=15,total_tokens=27),
            choices=[SimpleNamespace(finish_reason='stop',message=SimpleNamespace(refusal=None,content=json.dumps(payload)))])
    def fake_client(**kwargs):
        assert kwargs['max_retries'] == 0
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    monkeypatch.setattr(ai_evaluator,'OpenAI',fake_client)
    record={'language':'RU','channel':'agent chat','transcript':[{'text':'Вопрос','timestamp':'00:00','speaker':'client'},{'text':'Здравствуйте!','timestamp':'00:02','speaker':'operator'}]}
    output=ai_evaluator.evaluate(record,default_checklist())
    assert len(output['results']) == 8 and output['usage']['total_tokens'] == 27
    assert captured['response_format']['json_schema']['strict'] is True
    assert captured['response_format']['type'] == 'json_schema'


def test_invalid_answer_usage_is_recorded(client,monkeypatch):
    def fail(*args):
        raise EvaluationValidationError('Неверная цитата',{'prompt_tokens':40,'completion_tokens':20})
    monkeypatch.setattr('backend.ai_evaluator.evaluate',fail)
    assert client.post('/api/evaluate/test-1',headers=SUPERVISOR).status_code == 502
    assert client.get('/api/health').json()['budget']['prompt_tokens'] == 40


def test_dynamic_checklist_validation():
    c = default_checklist(); c[0]["id"] = c[1]["id"]
    with pytest.raises(ValueError):
        ChecklistUpdate(version=1,criteria=c)
    c = default_checklist(); c[-1]["weight"] = 2
    with pytest.raises(ValueError):
        ChecklistUpdate(version=1,criteria=c)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-placeholder")
    monkeypatch.setenv("OPENAI_MAX_CALLS", "3")
    monkeypatch.delenv("QA_SUPERVISOR_TOKEN", raising=False)
    path = tmp_path / "dataset.json"
    path.write_text(json.dumps({"isSuccess":True,"data":{"dataset_group_id":"TEST","total_records":2,
        "records":[{"conversation_id":cid,"language":"RU","channel":"agent chat","audio_url":None,
                    "transcript":[{"speaker":"client","text":"Вопрос","timestamp":"00:00"},
                                  {"speaker":"operator","text":"Здравствуйте!","timestamp":"00:02"}]}
                   for cid in ("test-1","test-2")]}}),encoding="utf-8")
    def fake(record, criteria):
        return {"results":results(criteria),"model":"mock-no-network","usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}
    monkeypatch.setattr("backend.ai_evaluator.evaluate", fake)
    return TestClient(create_app(tmp_path / "store.json",path))


def evaluated(client):
    response = client.post('/api/evaluate/test-1',headers=SUPERVISOR)
    assert response.status_code == 200
    return response.json()["evaluation"]


def appeal(client, evaluation, cid="01"):
    response = client.post('/api/appeals/submit',headers=OPERATOR,json={"conversation_id":"test-1","criterion_id":cid,
        "evaluation_id":evaluation["id"],"comment":"Не согласен с оценкой по реплике"})
    assert response.status_code == 200
    return response.json()


def test_unlimited_evaluations_keep_cache_and_persistent_usage(client):
    evaluated(client)
    assert client.post('/api/evaluate/test-1',headers=SUPERVISOR).json()["cached"]
    assert client.get('/api/health').json()["budget"]["attempts"] == 1
    for _ in range(4):
        assert client.post('/api/evaluate/test-1?force=true',headers=SUPERVISOR).status_code == 200
    assert client.post('/api/evaluate/test-2',headers=SUPERVISOR).status_code == 200
    s = client.app.state.store
    from backend.main import Store
    persisted = Store(s.path).budget()
    assert persisted["attempts"] == 6
    assert persisted["limit"] is None and persisted["remaining"] is None


def test_failed_request_records_usage_without_fabricated_score(client,monkeypatch):
    def fail(*args):
        raise RuntimeError("Test provider failure")
    monkeypatch.setattr("backend.ai_evaluator.evaluate",fail)
    assert client.post('/api/evaluate/test-1',headers=SUPERVISOR).status_code == 502
    assert client.get('/api/health').json()["budget"]["attempts"] == 1
    assert client.get('/api/conversations/test-1').json()["evaluation"] is None


def test_appeal_approve_recalculates_audits_and_cannot_resolve_twice(client):
    e = evaluated(client); a = appeal(client,e)
    assert client.post('/api/evaluate/test-1?force=true',headers=SUPERVISOR).status_code == 409
    body = {"conversation_id":"test-1","criterion_id":"01","appeal_id":a["id"],"action":"APPROVED",
            "new_score":0,"resolution_comment":"Приветствие не соответствует правилу"}
    assert client.post('/api/appeals/resolve',json=body,headers=OPERATOR).status_code == 403
    response = client.post('/api/appeals/resolve',json=body,headers=SUPERVISOR)
    assert response.status_code == 200
    assert response.json()["evaluation"]["final_score"] == 90
    assert response.json()["evaluation"]["results"][0]["reason"] == e["results"][0]["reason"]
    assert client.post('/api/appeals/resolve',json=body,headers=SUPERVISOR).status_code == 409
    assert client.get('/api/conversations/test-1').json()["history"][0]["final_score"] == 100
    assert client.get('/api/audit',headers=SUPERVISOR).json()["events"][-1]["action"] == "appeal_resolved"


def test_reject_preserves_score_and_duplicate_pending_is_blocked(client):
    e = evaluated(client); a = appeal(client,e)
    duplicate={"conversation_id":"test-1","criterion_id":"01","evaluation_id":e["id"],"comment":"Вторая апелляция на критерий"}
    assert client.post('/api/appeals/submit',json=duplicate,headers=OPERATOR).status_code == 409
    response=client.post('/api/appeals/resolve',headers=SUPERVISOR,json={"conversation_id":"test-1","criterion_id":"01","appeal_id":a["id"],"action":"REJECTED","resolution_comment":"Оценка подтверждена исходной репликой"})
    assert response.status_code == 200 and response.json()["evaluation"]["final_score"] == 100


def test_appeal_na_and_scale_validation(client):
    e = evaluated(client); a = appeal(client,e,"06")
    body={"conversation_id":"test-1","criterion_id":"06","appeal_id":a["id"],"action":"APPROVED","new_score":5,"resolution_comment":"Проверка ограничений ступеней шкалы"}
    assert client.post('/api/appeals/resolve',headers=SUPERVISOR,json=body).status_code == 422
    body.update(new_score=7)
    assert client.post('/api/appeals/resolve',headers=SUPERVISOR,json=body).json()["evaluation"]["final_score"] == 95.5


def test_weight_change_no_ai_and_rule_change_stale(client):
    e = evaluated(client); a = appeal(client,e)
    config=client.get('/api/checklist').json(); config['criteria'][0]['weight']=20
    response=client.post('/api/checklist',headers=SUPERVISOR,json=config)
    assert response.status_code == 200
    assert response.json()['rescored'] == 1 and not response.json()['requires_ai']
    assert client.get('/api/health').json()['budget']['attempts'] == 1
    assert client.get('/api/conversations/test-1').json()['status'] == 'Evaluated'
    assert client.post('/api/checklist',headers=SUPERVISOR,json=config).status_code == 409
    config=client.get('/api/checklist').json(); config['criteria'][0]['description']+=' Дополнительное правило.'
    response=client.post('/api/checklist',headers=SUPERVISOR,json=config)
    assert response.json()['stale'] == 1
    detail=client.get('/api/conversations/test-1').json()
    assert detail['appeals'][0]['status'] == 'SUPERSEDED'
    assert detail['status'] == 'Stale'


def test_roles_token_search_and_batch_without_call_ceiling(client,monkeypatch):
    assert len(client.get('/api/conversations?search=Здравствуйте').json()['items']) == 2
    assert client.get('/api/conversations?language=EN').json()['items'] == []
    assert client.post('/api/evaluate/test-1',headers=OPERATOR).status_code == 403
    monkeypatch.setenv('QA_SUPERVISOR_TOKEN','qa-test-token')
    assert client.post('/api/evaluate/test-1',headers=SUPERVISOR).status_code == 403
    headers={**SUPERVISOR,'X-Supervisor-Token':'qa-test-token'}
    assert client.post('/api/evaluate/test-1',headers=headers).status_code == 200
    monkeypatch.setenv('OPENAI_MAX_CALLS','1')
    response=client.post('/api/evaluate-batch',headers=headers,json={'conversation_ids':['test-2']})
    assert response.status_code == 200
    assert len(response.json()['completed']) == 1
    assert response.json()['budget']['remaining'] is None


def test_checklist_add_remove_and_all_na(client):
    config=client.get('/api/checklist').json()
    config['criteria']=[{"id":"new","name":"Новый","description":"Новое правило","type":"binary","weight":10,
                         "allow_na":True,"na_condition":"Нет запроса"}]
    response=client.post('/api/checklist',headers=SUPERVISOR,json=config)
    assert response.status_code == 200
    criteria=response.json()['criteria']
    assert score_evaluation(criteria,[{"criterion_id":"new","value":None,"is_na":True}])['final_score'] is None


def test_organizer_html_audio_unwrapped_and_cached(tmp_path,monkeypatch):
    class FakeResponse:
        status_code=200
        def __init__(self,ct,content):
            self.headers={'Content-Type':ct}; self.content=content
        def iter_content(self,size):
            yield self.content
        def close(self):
            pass
    responses=iter([FakeResponse('text/html',b'<audio><source src="https://freedomholdingcorporation.crm11.dynamics.com/api/filedownload/a"></audio>'),FakeResponse('audio/mpeg',b'ID3test-audio')])
    monkeypatch.setattr('backend.main.requests.get',lambda *a,**kw: next(responses))
    target=tmp_path/'audio.mp3'; cache_audio('https://example.api.powerplatform.com/audio',target)
    assert target.read_bytes() == b'ID3test-audio'


def test_untrusted_audio_source_rejected(tmp_path,monkeypatch):
    class FakeResponse:
        status_code=200
        headers={'Content-Type':'text/html'}
        def iter_content(self,size):
            yield b'<source src="http://127.0.0.1/private">'
        def close(self):
            pass
    monkeypatch.setattr('backend.main.requests.get',lambda *a,**kw: FakeResponse())
    with pytest.raises(ValueError):
        cache_audio('https://example.api.powerplatform.com/audio',tmp_path/'audio.mp3')


@pytest.mark.parametrize('patch',[{'name':'   '},{'description':'\n  '},{'weight':True},{'allow_na':1},{'max_scale':False}])
def test_invalid_checklist_does_not_change_saved_rules(client,patch):
    before=client.get('/api/checklist').json()
    body=copy.deepcopy(before);body['criteria'][0].update(patch)
    assert client.post('/api/checklist',headers=SUPERVISOR,json=body).status_code == 422
    assert client.get('/api/checklist').json() == before


def test_boolean_manual_score_is_not_coerced_to_yes(client):
    e=evaluated(client);a=appeal(client,e)
    body={'conversation_id':'test-1','criterion_id':'01','appeal_id':a['id'],'action':'APPROVED',
          'new_score':True,'resolution_comment':'Проверка недопустимого типа оценки'}
    assert client.post('/api/appeals/resolve',headers=SUPERVISOR,json=body).status_code == 422
    assert client.get('/api/conversations/test-1').json()['evaluation']['final_score'] == 100


def fail_disk(*args):
    raise OSError('test disk failure')


def test_failed_checklist_write_rolls_back_memory_and_disk(client,monkeypatch):
    store=client.app.state.store
    before=copy.deepcopy(store.data);disk=store.path.read_bytes()
    body=client.get('/api/checklist').json();body['criteria'][0]['weight']=12
    monkeypatch.setattr('backend.main.os.replace',fail_disk)
    assert client.post('/api/checklist',headers=SUPERVISOR,json=body).status_code == 503
    assert store.data == before and store.path.read_bytes() == disk


def test_failed_budget_reservation_never_calls_evaluator(client,monkeypatch):
    called=[]
    monkeypatch.setattr('backend.ai_evaluator.evaluate',lambda *args: called.append(True))
    monkeypatch.setattr('backend.main.os.replace',fail_disk)
    assert client.post('/api/evaluate/test-1',headers=SUPERVISOR).status_code == 503
    assert called == [] and client.get('/api/health').json()['budget']['attempts'] == 0


def test_failed_result_commit_preserves_usage_without_showing_unsaved_score(client,monkeypatch):
    import os
    replace=os.replace;calls=[]
    def fail_completion_once(*args):
        calls.append(True)
        if len(calls) == 2:
            raise OSError('disk full while saving assessment')
        return replace(*args)
    monkeypatch.setattr('backend.main.os.replace',fail_completion_once)
    assert client.post('/api/evaluate/test-1',headers=SUPERVISOR).status_code == 503
    detail=client.get('/api/conversations/test-1').json()
    assert detail['evaluation'] is None
    budget=client.get('/api/health').json()['budget']
    assert budget['attempts'] == 1 and budget['prompt_tokens'] == 10 and budget['completion_tokens'] == 20


def test_failed_appeal_write_preserves_pending_and_original_score(client,monkeypatch):
    e=evaluated(client);a=appeal(client,e)
    monkeypatch.setattr('backend.main.os.replace',fail_disk)
    response=client.post('/api/appeals/resolve',headers=SUPERVISOR,json={
        'conversation_id':'test-1','criterion_id':'01','appeal_id':a['id'],'action':'APPROVED',
        'new_score':0,'resolution_comment':'Проверка сохранения решения'})
    assert response.status_code == 503
    detail=client.get('/api/conversations/test-1').json()
    assert detail['appeals'][0]['status'] == 'PENDING'
    assert detail['evaluation']['final_score'] == 100 and not detail['history']


def test_removed_records_supersede_appeals_and_are_not_rescored(client):
    e=evaluated(client);appeal(client,e)
    store=client.app.state.store
    payload={'isSuccess':True,'data':{'dataset_group_id':'OTHER','total_records':1,
              'records':[copy.deepcopy(store.data['records']['test-2'])]}}
    store.import_data(payload)
    assert store.data['appeals'][0]['status'] == 'SUPERSEDED'
    assert client.get('/api/conversations/test-1').status_code == 404
    config=client.get('/api/checklist').json();config['criteria'][0]['weight']=12
    response=client.post('/api/checklist',headers=SUPERVISOR,json=config)
    assert response.status_code == 200 and response.json()['rescored'] == 0
    payload['data']['records'][0]['transcript'][0]['text']='changed outside store'
    assert store.data['records']['test-2']['transcript'][0]['text'] == 'Вопрос'


@pytest.mark.parametrize('payload',[
    {'isSuccess':True,'data':None},
    {'isSuccess':True,'data':{'records':[None]}},
    {'isSuccess':True,'data':{'records':[{'conversation_id':'bad/id'}]}},
])
def test_malformed_dataset_reports_validation_error(payload):
    from backend.dataset import unpack_dataset
    with pytest.raises(ValueError):
        unpack_dataset(payload)


@pytest.mark.parametrize('field,value',[('transcript',[None]),('audio_url',123),('conversation_id','bad/id')])
def test_bad_dataset_record_cannot_replace_current_data(client,field,value):
    store=client.app.state.store;before=copy.deepcopy(store.data)
    record=copy.deepcopy(before['records']['test-1']);record[field]=value
    with pytest.raises(ValueError):
        store.import_data({'isSuccess':True,'data':{'records':[record]}})
    assert store.data == before


def test_audio_source_split_across_http_chunks(tmp_path,monkeypatch):
    class Response:
        status_code=200
        def __init__(self,kind,chunks):
            self.headers={'Content-Type':kind};self.chunks=chunks
        def iter_content(self,size):
            yield from self.chunks
        def close(self):
            pass
    responses=iter([Response('text/html',[b'<audio><sou',b'rce src="https://freedomholdingcorporation.crm11.dynamics.com/a"></audio>']),
                    Response('audio/mpeg',[b'ID3',b'test'])])
    monkeypatch.setattr('backend.main.requests.get',lambda *args,**kwargs:next(responses))
    target=tmp_path/'voice.mp3';cache_audio('https://example.api.powerplatform.com/audio',target)
    assert target.read_bytes() == b'ID3test'


def test_cross_origin_audio_range_is_allowed(client):
    response=client.options('/api/conversations/test-1/audio',headers={
        'Origin':'http://localhost:8000','Access-Control-Request-Method':'GET',
        'Access-Control-Request-Headers':'range'})
    assert response.status_code == 200


def test_file_import_does_not_start_app_or_create_store(client,tmp_path):
    import os,subprocess,sys
    source=tmp_path/'source.json';destination=tmp_path/'imported.json';store=tmp_path/'unexpected-store.json'
    source.write_text(json.dumps({'isSuccess':True,'data':{'records':[client.app.state.store.data['records']['test-1']]}}),encoding='utf-8')
    env={**os.environ,'DATA_STORE_PATH':str(store)}
    response=subprocess.run([sys.executable,'scripts/import_dataset.py',str(source),'--destination',str(destination)],
                            env=env,capture_output=True,text=True,check=True)
    assert destination.exists() and not store.exists()


@pytest.mark.parametrize('payload',[{'results':[]},{'results':{}},{'results':{'01':{'value':True}}}])
def test_malformed_model_response_is_rejected_with_usage(monkeypatch,payload):
    from types import SimpleNamespace
    from backend import ai_evaluator
    monkeypatch.setenv('OPENAI_API_KEY','test-placeholder')
    response=SimpleNamespace(model='mock',usage=SimpleNamespace(prompt_tokens=3,completion_tokens=4,total_tokens=7),
        choices=[SimpleNamespace(finish_reason='stop',message=SimpleNamespace(refusal=None,content=json.dumps(payload)))])
    monkeypatch.setattr(ai_evaluator,'OpenAI',lambda **kwargs:SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw:response))))
    with pytest.raises(EvaluationValidationError) as error:
        ai_evaluator.evaluate({'language':'RU','channel':'agent chat','transcript':[]},default_checklist())
    assert error.value.usage['total_tokens'] == 7


def test_appeals_workspace_lists_pending_and_resolved(client):
    e=evaluated(client);a=appeal(client,e)
    overview=client.get('/api/appeals',headers=SUPERVISOR).json()
    assert overview['total'] == 1 and overview['pending'] == 1
    assert overview['items'][0]['criterion_name'] == 'Установление контакта'
    assert overview['items'][0]['conversation_available'] is True
    client.post('/api/appeals/resolve',headers=SUPERVISOR,json={'conversation_id':'test-1','criterion_id':'01','appeal_id':a['id'],
        'action':'REJECTED','resolution_comment':'Оценка подтверждена исходной репликой'})
    overview=client.get('/api/appeals',headers=SUPERVISOR).json()
    assert overview['pending'] == 0 and overview['items'][0]['status'] == 'REJECTED'


def test_removed_conversation_appeal_remains_visible_without_broken_link(client):
    e=evaluated(client);appeal(client,e)
    store=client.app.state.store
    store.import_data({'isSuccess':True,'data':{'records':[store.data['records']['test-2']]}})
    item=client.get('/api/appeals',headers=SUPERVISOR).json()['items'][0]
    assert item['status'] == 'SUPERSEDED' and item['conversation_available'] is False


def test_appeals_workspace_respects_supervisor_token(client,monkeypatch):
    monkeypatch.setenv('QA_SUPERVISOR_TOKEN','qa-test-token')
    assert client.get('/api/appeals',headers=SUPERVISOR).status_code == 403
    assert client.get('/api/appeals',headers={**SUPERVISOR,'X-Supervisor-Token':'qa-test-token'}).status_code == 200


def test_paid_api_is_blocked_in_standard_tests():
    from openai import OpenAI
    with pytest.raises(AssertionError,match='disabled in ordinary tests'):
        OpenAI(api_key='test-placeholder').chat.completions.create(model='gpt-4o',messages=[])


def test_live_workflow_import_flag_appeal_rules_and_new_evaluation(client, monkeypatch):
    """Real endpoints and store; evaluator is a clearly isolated, unpaid test double."""
    calls = []
    def fake(record, criteria):
        calls.append(record["conversation_id"])
        message = record["transcript"][-1]
        rows = [{"criterion_id": c["id"], "value": 1 if c["type"] == "flag" else 0,
                 "is_na": False, "reason": "Тестовое обоснование для проверки процесса",
                 "proof_quote": message["text"], "proof_message_index": len(record["transcript"])-1,
                 "proof_timestamp": message["timestamp"]} for c in criteria]
        validate_evidence(rows, criteria, record["transcript"])
        return {"results": rows, "model": "mock-no-network", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
    monkeypatch.setattr("backend.ai_evaluator.evaluate", fake)
    imported = client.post('/api/conversations/import', headers=SUPERVISOR, json={"title":"Workflow test", "language":"RU",
        "transcript":[{"speaker":"client","text":"Вопрос","timestamp":"00:00"},
                      {"speaker":"operator","text":"Тестовая реплика оператора","timestamp":"00:05"}]}).json()
    cid = imported['id']
    e = client.post('/api/evaluate/'+cid, headers=SUPERVISOR).json()['evaluation']
    assert e['has_gross_violation'] and e['final_score'] == 0
    flagged = client.get('/api/conversations', params={'gross_only':'true'}).json()['items']
    assert [r['id'] for r in flagged] == [cid]
    assert client.get('/api/conversations/'+cid).json()['evaluation']['criteria'][-1]['proof_quote'] == 'Тестовая реплика оператора'
    a = client.post('/api/appeals/submit', headers=OPERATOR, json={'conversation_id':cid,'criterion_id':'08',
        'evaluation_id':e['id'],'comment':'Проверка оспаривания классификации'}).json()
    assert client.get('/api/appeals', headers=SUPERVISOR).json()['pending'] == 1
    body = {'conversation_id':cid,'criterion_id':'08','appeal_id':a['id'],'action':'APPROVED','new_score':0,
            'resolution_comment':'Руководитель снял флаг в тестовом сценарии'}
    assert client.post('/api/appeals/resolve', headers=SUPERVISOR, json=body).status_code == 200
    assert not client.get('/api/conversations', params={'gross_only':'true'}).json()['items']
    assert len(calls) == 1
    config = client.get('/api/checklist').json();config['criteria'][0]['weight'] = 12
    changed = client.post('/api/checklist', headers=SUPERVISOR, json=config).json()
    assert changed['rescored'] == 1 and not changed['requires_ai'] and len(calls) == 1
    config = client.get('/api/checklist').json()
    config['criteria'].append({**config['criteria'][0], 'id':'new','name':'Новый критерий', 'description':'Проверить новое правило', 'weight':3})
    changed = client.post('/api/checklist', headers=SUPERVISOR, json=config).json()
    assert changed['requires_ai'] and client.get('/api/conversations/'+cid).json()['status'] == 'Stale'
    index = client.get('/api/conversations').json()['items']
    assert not next(r for r in index if r['id'] == cid)['has_gross_violation']
    assert not client.get('/api/conversations', params={'gross_only':'true'}).json()['items']
    updated = client.post('/api/evaluate/'+cid, headers=SUPERVISOR).json()['evaluation']
    assert len(updated['criteria']) == 9 and len(calls) == 2
    assert [r['id'] for r in client.get('/api/conversations', params={'gross_only':'true'}).json()['items']] == [cid]
    events = client.get('/api/audit', headers=SUPERVISOR).json()['events']
    assert {'conversation_imported','evaluation_completed','appeal_submitted','appeal_resolved','checklist_updated'}.issubset({e['action'] for e in events})

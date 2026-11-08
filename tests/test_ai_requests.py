"""Synthetic full request boundary tests. Transport returns fixtures, never network."""
import copy
import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import ai_gateway, manager_assistant
from backend.main import create_app

SUP = {"X-Role": "supervisor"}
OP = {"X-Role": "operator"}


def search_answer(**patch):
    fields = {key: None for key in manager_assistant.FILTER_KEYS}
    fields.update(patch)
    return {"kind": "search", "operation": "merge", "filters": fields, "clear_fields": [], "clarification": None}


@pytest.fixture
def boundary(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_MAX_CALLS", "unlimited")
    monkeypatch.setenv("OPENAI_ASSISTANT_MAX_CALLS", "20")
    monkeypatch.delenv("QA_SUPERVISOR_TOKEN", raising=False)
    app = create_app(tmp_path/'store.json', tmp_path/'missing.json')
    store = app.state.store
    for cid, lang in [('r1','RU'),('k1','KZ')]:
        store.data['records'][cid] = {'conversation_id':cid,'language':lang,'channel':'agent chat','audio_url':None,
            'transcript':[
                {'id':'m1','speaker':'client','timestamp':'00:00','text':'Меня зовут Иван Петров. ИИН 990101123456. Email ivan@example.test. Тариф 500 тенге, срок 3 дня. СекретАльфа'},
                {'id':'m2','speaker':'operator','timestamp':'00:10','text':'Здравствуйте! Меня зовут Алина. Позвоните +7 701 123 45 67. До свидания!'}]}
    store.save()
    transport = {'calls':[], 'answer': search_answer(gross_only=True)}
    def create(**request):
        transport['calls'].append(copy.deepcopy(request))
        payload = json.loads(request['messages'][1]['content'])
        name = request['response_format']['json_schema']['name']
        if name == 'cqa_evaluation':
            rows = {}
            for c in payload['checklist']:
                value = 0 if c['source_id']=='07' else 1 if c['type']=='flag' else c['max_scale']
                failed = c['source_id']=='07' or c['type']=='flag'
                rows[c['id']] = {'criterion_id':c['id'],'value':bool(value) if c['type']!='scale' else value,
                    'rationale':'Отсутствует завершение.' if c['source_id']=='07' else 'Синтетическое обоснование.',
                    'proof_turn':len(payload['transcript']),'evidence_turns':[len(payload['transcript'])],
                    'recommendation':'Подведите итог.' if failed else '',
                    'practice_task':'Перепишите завершение.' if failed else ''}
                rows[c['id']].update(transport.get('evaluation_patch', {}).get(c['source_id'], {}))
            response = {'status':'evaluated','manual_review':None,'results':rows}
        elif name == 'cqa_practice':
            response = {'value':1,'worked':'Есть предложение помощи.','improve':'','why':'Правило выполнено.','answer_quote':payload['answer']}
        elif name == 'cqa_manager_priorities':
            response = {'selected_ids':[c['id'] for c in payload['server_candidates'][:3]]}
        else:
            response = transport['answer']
        return SimpleNamespace(model='fixture-model',usage=SimpleNamespace(prompt_tokens=10,completion_tokens=5,total_tokens=15),
            choices=[SimpleNamespace(finish_reason=transport.get('finish_reason','stop'),message=SimpleNamespace(refusal=transport.get('refusal'),content=json.dumps(response)))])
    monkeypatch.setattr(ai_gateway,'OpenAI',lambda **kw:SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))
    # Existing wrappers intentionally expose their own factory for tests.
    monkeypatch.setattr('backend.ai_evaluator.OpenAI', ai_gateway.OpenAI)
    monkeypatch.setattr('backend.ai_coach.OpenAI', ai_gateway.OpenAI)
    return TestClient(app), store, transport


def preview(client, purpose='evaluation', headers=SUP, **kwargs):
    response=client.post('/api/ai/prepare',headers=headers,json={'purpose':purpose,**kwargs})
    assert response.status_code==200,response.text
    return response.json()


def evaluate(client,cid='r1',force=False,redactions=None):
    p=preview(client,conversation_id=cid,force=force,redactions=redactions or [])
    response=client.post(f'/api/evaluate/{cid}?force={str(force).lower()}',headers={**SUP,'X-AI-Preview':p['preview_id']})
    assert response.status_code==200,response.text
    return response.json()['evaluation']


def test_preview_is_exact_outbound_and_proof_returns_to_original_message(boundary):
    client,store,transport=boundary
    p=preview(client,conversation_id='r1',redactions=['СекретАльфа'])
    serialized=json.dumps(p,ensure_ascii=False)
    for raw in ['Иван Петров','990101123456','ivan@example.test','Алина','+7 701 123 45 67','СекретАльфа']:
        assert raw not in serialized
    assert '500 тенге' in serialized and '3 дня' in serialized
    assert client.post('/api/evaluate/r1',headers=SUP).status_code==428
    result=client.post('/api/evaluate/r1',headers={**SUP,'X-AI-Preview':p['preview_id']})
    assert result.status_code==200,result.text
    assert transport['calls']==[p['requests'][0]['request']]
    assert transport['calls'][0]['store'] is False
    criterion=result.json()['evaluation']['results'][0]
    assert criterion['proof_message_id']=='m2'
    assert criterion['proof_quote']==store.data['records']['r1']['transcript'][1]['text']
    assert '[ОПЕРАТОР_' in criterion['sent_proof_quote']
    assert store.data['records']['r1']['transcript'][0]['text'].startswith('Меня зовут Иван Петров')
    exported=client.get('/api/conversations/r1').json()
    assert exported['evaluation']['id']==result.json()['evaluation']['id']


def test_stale_source_and_changed_policy_reject_old_preview(boundary):
    client,store,transport=boundary
    p=preview(client,conversation_id='r1')
    store.data['records']['r1']['transcript'][0]['text']+=' Изменено.'
    assert client.post('/api/evaluate/r1',headers={**SUP,'X-AI-Preview':p['preview_id']}).status_code==409
    p=preview(client,conversation_id='r1')
    assert client.post('/api/ai/privacy',headers=SUP,json={'mask_personal_data':False,'block_external_ai':False}).status_code==200
    assert client.post('/api/evaluate/r1',headers={**SUP,'X-AI-Preview':p['preview_id']}).status_code==409
    assert not transport['calls'] and store.data['budget']['attempts']==0


def test_mask_failure_fails_closed_and_old_preview_cannot_authorize_changed_answer(boundary,monkeypatch):
    client,store,transport=boundary
    monkeypatch.setattr(ai_gateway.LocalMasker,'mask',lambda *args:(_ for _ in ()).throw(RuntimeError('secret-original')))
    response=client.post('/api/ai/prepare',headers=SUP,json={'purpose':'evaluation','conversation_id':'r1'})
    assert response.status_code==422 and 'secret-original' not in response.text
    assert client.post('/api/evaluate/r1',headers=SUP).status_code==428
    assert not transport['calls']


def test_batch_and_force_use_gateway_and_keep_originals(boundary):
    client,store,transport=boundary
    p=preview(client,'batch',conversation_ids=['r1','k1'],redactions=['СекретАльфа'])
    result=client.post('/api/evaluate-batch',headers={**SUP,'X-AI-Preview':p['preview_id']},json={'conversation_ids':['r1','k1']})
    assert result.status_code==200 and len(result.json()['completed'])==2,result.text
    assert transport['calls']==[r['request'] for r in p['requests']]
    evaluate(client,force=True,redactions=['СекретАльфа'])
    assert len(transport['calls'])==3
    outgoing=json.dumps(transport['calls'],ensure_ascii=False)
    assert '990101123456' not in outgoing and 'СекретАльфа' not in outgoing
    assert len(store.data['history']['r1'])==1


def test_block_all_external_paths_preserves_cached_and_manual_work(boundary):
    client,store,transport=boundary
    evaluation=evaluate(client)
    pp=preview(client,'practice',headers=OP,conversation_id='r1',criterion_id='07',answer='Могу помочь?',language='ru')
    ex=client.get('/api/practice/r1/07',headers=OP).json()
    assert client.post('/api/ai/privacy',headers=OP,json={'mask_personal_data':True,'block_external_ai':True}).status_code==403
    assert client.post('/api/ai/privacy',headers=SUP,json={'mask_personal_data':True,'block_external_ai':True}).status_code==200
    before=len(transport['calls'])
    for url,body in [('/api/evaluate/k1',{}),('/api/evaluate/r1?force=true',{}),('/api/evaluate-batch',{'conversation_ids':['k1']}),
                     ('/api/ai/prepare',{'purpose':'assistant_search','query':'Покажи грубые ошибки'}),
                     ('/api/ai/prepare',{'purpose':'assistant_recommendations'})]:
        assert client.post(url,headers=SUP,json=body).status_code==403
    answer={'exercise_key':ex['exercise_key'],'evaluation_id':ex['evaluation_id'],'answer':'Могу помочь?','language':'ru','request_id':str(uuid.uuid4()),'preview_id':pp['preview_id']}
    assert client.post('/api/practice/r1/07',headers=OP,json=answer).status_code==403
    assert client.post('/api/evaluate/r1',headers=SUP).json()['cached']
    assert client.post('/api/assistant/filter',headers=SUP,json={'filters':{'language':'RU'}}).json()['total']==1
    appeal=client.post('/api/appeals/submit',headers=OP,json={'conversation_id':'r1','criterion_id':'07','evaluation_id':evaluation['id'],'comment':'Проверить завершение вручную'})
    assert appeal.status_code==200
    assert len(transport['calls'])==before


def test_assistant_search_followups_counts_and_limits_no_transcripts_sent(boundary,monkeypatch):
    client,store,transport=boundary
    evaluate(client,'r1');evaluate(client,'k1')
    def ask(query,filters=None):
        p=preview(client,'assistant_search',query=query,filters=filters or {})
        content=p['requests'][0]['request']['messages'][1]['content']
        assert 'transcript' not in content and '990101123456' not in content and 'СекретАльфа' not in content
        return client.post('/api/assistant',headers=SUP,json={'preview_id':p['preview_id']})
    # Regression: the main list was showing unassessed records before the query.
    first=ask('Покажи грубые ошибки', {'status':'Pending'}).json()
    assert first['result_count']==2 and first['coverage']['evaluated']==2
    assert first['filters']['status'] is None and first['filters']['gross_only']
    local=client.post('/api/assistant/filter',headers=SUP,json={'filters':{'status':'Pending','gross_only':True}}).json()
    assert local['total']==2 and local['filters']['status'] is None
    transport['answer']=search_answer(language='RU')
    second=ask('Только на русском',first['filters']).json()
    assert second['filters']['gross_only'] and second['result_count']==1
    assert second['items'][0]['issues'][0]['evidence']['message_id']=='m2'
    assert second['dataset']['synthetic']
    assert len(client.get('/api/assistant/history',headers=SUP).json()['messages'])==2
    assert client.get('/api/assistant/history',headers=OP).status_code==403
    monkeypatch.setenv('OPENAI_ASSISTANT_MAX_CALLS','2')
    assert client.post('/api/ai/prepare',headers=SUP,json={'purpose':'assistant_search','query':'Ещё'}).status_code==429
    monkeypatch.setenv('OPENAI_ASSISTANT_MAX_CALLS','20')
    monkeypatch.setenv('OPENAI_MAX_CALLS',str(store.data['budget']['attempts']))
    assert client.post('/api/ai/prepare',headers=SUP,json={'purpose':'assistant_search','query':'Ещё'}).status_code==429


def test_recommendations_use_final_appeals_and_authoritative_sources(boundary):
    client,store,transport=boundary
    evaluation=evaluate(client)
    appeal=client.post('/api/appeals/submit',headers=OP,json={'conversation_id':'r1','criterion_id':'08','evaluation_id':evaluation['id'],'comment':'Грубая ошибка отсутствует'}).json()
    resolution=client.post('/api/appeals/resolve',headers=SUP,json={'conversation_id':'r1','criterion_id':'08','appeal_id':appeal['id'],'action':'APPROVED','new_score':0,'resolution_comment':'Нарушение не подтверждено'})
    assert resolution.status_code==200
    p=preview(client,'assistant_recommendations')
    content=json.loads(p['requests'][0]['request']['messages'][1]['content'])
    assert content['coverage']=={'evaluated':1,'total':2,'statuses':{'Pending':1,'Evaluating':0,'Evaluated':1,'Stale':0,'Error':0,'Review':0}}
    assert all(c['id']!='gross_violations' for c in content['server_candidates'])
    result=client.post('/api/assistant',headers=SUP,json={'preview_id':p['preview_id']})
    assert result.status_code==200,result.text
    assert 1<=len(result.json()['recommendations'])<=3
    rec=result.json()['recommendations'][0]
    assert rec['count']==1 and rec['sample_size']==1 and rec['sources'][0]['conversation_id']=='r1'
    assert client.get('/api/conversations/r1').json()['evaluation']['has_gross_violation'] is False


def test_previews_bound_to_role_and_supervisor_token(boundary,monkeypatch):
    client,store,transport=boundary
    assert client.post('/api/ai/prepare',headers=OP,json={'purpose':'assistant_search','query':'Чаты'}).status_code==403
    monkeypatch.setenv('QA_SUPERVISOR_TOKEN','synthetic-token')
    assert client.post('/api/ai/prepare',headers=SUP,json={'purpose':'evaluation','conversation_id':'r1'}).status_code==403
    headers={**SUP,'X-Supervisor-Token':'synthetic-token'}
    p=preview(client,headers=headers,conversation_id='r1')
    assert client.post('/api/evaluate/r1',headers={**OP,'X-AI-Preview':p['preview_id']}).status_code==403
    assert not transport['calls']


def test_technical_audit_keeps_metadata_without_private_request_or_appeal_text(boundary):
    client, store, transport = boundary
    evaluation = evaluate(client)
    comment = 'Мой адрес private-audit@example.invalid, уточните оценку'
    result = client.post('/api/appeals/submit', headers=OP, json={
        'conversation_id': 'r1', 'criterion_id': '07', 'evaluation_id': evaluation['id'], 'comment': comment,
    })
    assert result.status_code == 200
    audit = json.dumps(store.data['audit'], ensure_ascii=False)
    for private in (comment, '990101123456', 'ivan@example.test', 'Алина', 'СекретАльфа'):
        assert private not in audit
    event = next(item for item in store.data['audit'] if item['action'] == 'external_ai_request')
    assert event['conversation_id'] == 'r1' and event['provider'] == 'openai'
    assert event['purpose'] == 'evaluation' and event['protection'] == 'masked'
    assert event['timestamp'] and event['privacy_revision'] == 1
    assert store.data['appeals'][0]['comment'] == comment


def test_legacy_audit_content_is_removed_without_changing_business_records(boundary):
    from backend.main import Store
    client, store, transport = boundary
    evaluate(client)
    original = copy.deepcopy(store.data['records'])
    store.data['audit'].append({
        'id': 'legacy', 'timestamp': '2026-01-01', 'action': 'appeal_resolved', 'role': 'supervisor',
        'conversation_id': 'r1', 'before': copy.deepcopy(store.data['evaluations']['r1']),
        'request': {'text': 'private@example.invalid'},
        'appeal': {'id': 'a1', 'conversation_id': 'r1', 'status': 'APPROVED', 'comment': 'private@example.invalid'},
    })
    store.save()
    reopened = Store(store.path)
    legacy = next(item for item in reopened.data['audit'] if item['id'] == 'legacy')
    assert 'request' not in legacy and 'comment' not in legacy['appeal']
    assert legacy['before'] == {'final_score': 95.0}
    assert reopened.data['records'] == original


def test_assistant_frequency_question_one_call_with_actual_counts_and_no_transcripts(boundary):
    client,store,transport=boundary
    evaluate(client,'r1'); evaluate(client,'k1')
    transport['answer']=search_answer()
    transport['answer'].update(kind='summary', clarification='Irrelevant model text with invented counts')
    before=len(transport['calls'])
    p=preview(client,'assistant_search',query='Какие ошибки повторяются чаще всего',filters={'gross_only':True})
    sent=p['requests'][0]['request']['messages'][1]['content']
    assert 'transcript' not in sent and '990101123456' not in sent
    result=client.post('/api/assistant',headers=SUP,json={'preview_id':p['preview_id']})
    assert result.status_code==200,result.text
    body=result.json();assert body['kind']=='summary' and body['filters']['gross_only']
    assert len(transport['calls'])==before+1
    assert body['filtered_coverage']['evaluated']==2
    rows={row['criterion_id']:row for row in body['issues_summary']}
    assert rows['08']['count']==2 and rows['08']['sample_size']==2
    assert rows['08']['sources'][0]['evidence']['message_id']=='m2'
    assert 'invented counts' not in result.text
    transport['answer']=search_answer(language='RU');transport['answer']['kind']='summary'
    p=preview(client,'assistant_search',query='Только на русском',filters=body['filters'])
    body=client.post('/api/assistant',headers=SUP,json={'preview_id':p['preview_id']}).json()
    assert body['filtered_coverage']['evaluated']==1 and body['issues_summary'][0]['count']==1
    assert body['filters']['language']=='RU' and body['filters']['gross_only']


@pytest.mark.parametrize('failure,code', [('invalid','invalid_command'),('length','incomplete'),('refusal','refusal')])
def test_assistant_errors_keep_safe_diagnostics_without_retries(boundary,failure,code):
    client,store,transport=boundary
    if failure=='invalid': transport['answer']['filters']['criterion_state']='unmet' # Missing criterion ID.
    if failure=='length': transport['finish_reason']='length'
    if failure=='refusal': transport['refusal']='Unlogged sensitive provider explanation'
    p=preview(client,'assistant_search',query='Какие ошибки повторяются чаще всего')
    result=client.post('/api/assistant',headers=SUP,json={'preview_id':p['preview_id']})
    assert result.status_code==502
    assert 'уточнить формулировку' not in result.text and 'Unlogged' not in result.text
    assert len(transport['calls'])==1 and store.data['budget']['attempts']==1
    assert not store.data.get('assistant_history')
    event=store.data['audit'][-1]
    assert event['action']=='assistant_failed' and event['error_code']==code
    assert 'Unlogged' not in json.dumps(event) and 'Какие ошибки' not in json.dumps(event)


def test_replacing_criterion_and_weight_sends_new_rule_then_rescores_without_model(boundary):
    client,store,transport=boundary
    evaluate(client)
    original_count=len(transport['calls'])
    config=client.get('/api/checklist').json()
    config['criteria'][0].update(name='Следующий шаг',description='Проверить, предложен ли следующий шаг клиенту.',weight=25)
    changed=client.post('/api/checklist',headers=SUP,json=config)
    assert changed.status_code==200 and changed.json()['requires_ai']
    assert client.get('/api/conversations/r1').json()['status']=='Stale'
    assert len(transport['calls'])==original_count
    p=preview(client,conversation_id='r1')
    payload=json.loads(p['requests'][0]['request']['messages'][1]['content'])
    criterion=next(c for c in payload['checklist'] if c['source_id']=='01')
    assert criterion['description']==config['criteria'][0]['description'] and criterion['weight']==25
    assert criterion['id']=='01'  # The replacement no longer inherits the default contact rule.
    assert client.post('/api/evaluate/r1',headers={**SUP,'X-AI-Preview':p['preview_id']}).status_code==200
    assert client.get('/api/conversations/r1').json()['status']=='Evaluated'
    config=client.get('/api/checklist').json();config['criteria'][0]['weight']=35
    before=len(transport['calls']); changed=client.post('/api/checklist',headers=SUP,json=config).json()
    assert changed['rescored']==1 and not changed['requires_ai'] and len(transport['calls'])==before

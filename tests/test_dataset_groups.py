"""Multiple organizer sets share storage without sharing scores or spending tokens."""
import copy

from backend.dataset import record_group
from backend.main import create_app
from fastapi.testclient import TestClient
from test_cqa import client, evaluated, appeal, SUPERVISOR
from test_ai_requests import boundary, evaluate, preview, search_answer, SUP


def payload(group, cid):
    return {'isSuccess': True, 'data': {'dataset_group_id': group, 'total_records': 1, 'records': [
        {'conversation_id': cid, 'language': 'RU', 'channel': 'agent chat', 'audio_url': None,
         'transcript': [{'speaker': 'client', 'timestamp': '00:00', 'text': 'Вопрос'},
                        {'speaker': 'operator', 'timestamp': '00:02', 'text': 'Здравствуйте!'}]}]}}


def test_import_keeps_other_sets_scores_pending_appeals_and_budget(client):
    evaluation = evaluated(client)
    appeal(client, evaluation)
    store = client.app.state.store
    before = copy.deepcopy(store.data)
    for group, cid in [('FBroker', 'control-1'), ('Swap', 'swap-1')]:
        response = client.post('/api/dataset/import', headers=SUPERVISOR, json=payload(group, cid))
        assert response.status_code == 200, response.text
    data = client.get('/api/conversations').json()
    assert data['total'] == 4
    assert {g['id']: g['total'] for g in data['groups']} == {'TEST': 2, 'FBroker': 1, 'SWAP': 1}
    assert store.data['evaluations'] == before['evaluations']
    assert store.data['appeals'] == before['appeals']
    assert store.data['history'] == before['history']
    assert store.data['budget'] == before['budget']
    assert client.get('/api/conversations/test-1').json()['status'] == 'Evaluated'
    assert client.get('/api/conversations/control-1').json()['status'] == 'Pending'
    assert client.get('/api/conversations/swap-1').json()['evaluation_enabled'] is False
    # Idempotent reimport, then replacement within one group only.
    client.post('/api/dataset/import', headers=SUPERVISOR, json=payload('FBroker', 'control-1'))
    assert len(store.data['records']) == 4
    client.post('/api/dataset/import', headers=SUPERVISOR, json=payload('FBroker', 'control-2'))
    assert set(store.data['records']) == {'test-1', 'test-2', 'swap-1', 'control-2'}
    reloaded = create_app(store.path, store.path.parent/'missing.json').state.store
    assert reloaded.data == store.data
    assert record_group(reloaded.data, 'swap-1') == 'SWAP'


def test_group_import_rejects_collision_invalid_data_and_unauthorized_user(client):
    before = copy.deepcopy(client.app.state.store.data)
    assert client.post('/api/dataset/import', json=payload('FBroker', 'control-1')).status_code == 403
    assert client.post('/api/dataset/import', headers=SUPERVISOR, json=payload('FBroker', 'test-1')).status_code == 422
    assert client.post('/api/dataset/import', headers=SUPERVISOR, content=b'not json').status_code == 422
    assert client.app.state.store.data == before


def test_swap_single_force_prepare_and_batch_never_spend_budget(client):
    client.post('/api/dataset/import', headers=SUPERVISOR, json=payload('Swap', 'swap-1'))
    before = copy.deepcopy(client.app.state.store.data['budget'])
    for url, body in [('/api/evaluate/swap-1', {}), ('/api/evaluate/swap-1?force=true', {}),
                      ('/api/evaluate-batch', {'conversation_ids': ['test-1', 'swap-1']}),
                      ('/api/ai/prepare', {'purpose': 'batch', 'conversation_ids': ['test-1', 'swap-1']}),
                      ('/api/ai/prepare', {'purpose': 'evaluation', 'conversation_id': 'swap-1'})]:
        response = client.post(url, headers=SUPERVISOR, json=body)
        assert response.status_code == 409, response.text
        assert 'SWAP' in response.json()['detail']
    assert client.app.state.store.data['budget'] == before
    assert not client.app.state.store.data['evaluations']


def test_assistant_search_summary_and_priorities_respect_selected_dataset(boundary):
    client, store, transport = boundary
    store.data['record_groups'] = {'r1': 'DEV', 'k1': 'FBroker'}
    store.save()
    evaluate(client, 'r1'); evaluate(client, 'k1')
    calls = len(transport['calls'])
    scoped = client.post('/api/assistant/filter', headers=SUP, json={'dataset_group': 'FBroker', 'filters': {'gross_only': True}}).json()
    assert scoped['total'] == 1 and scoped['items'][0]['conversation_id'] == 'k1'
    assert scoped['coverage']['total'] == 1 and scoped['dataset']['synthetic'] is False
    assert len(transport['calls']) == calls
    all_sets = client.post('/api/assistant/filter', headers=SUP, json={'filters': {}}).json()
    assert all_sets['total'] == 2 and all_sets['dataset']['mixed'] and all_sets['dataset']['synthetic']
    transport['answer'] = {**search_answer(), 'kind': 'summary', 'operation': 'replace'}
    prepared = preview(client, purpose='assistant_search', dataset_group='FBroker', query='Какие ошибки повторяются?')
    response = client.post('/api/assistant', headers=SUP, json={'preview_id': prepared['preview_id']})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['dataset_group'] == 'FBroker' and result['coverage']['total'] == 1
    assert all(issue['count'] == issue['sample_size'] == 1 for issue in result['issues_summary'])
    assert all(source['conversation_id'] == 'k1' for issue in result['issues_summary'] for source in issue['sources'])
    prepared = preview(client, purpose='assistant_recommendations', dataset_group='FBroker')
    response = client.post('/api/assistant', headers=SUP, json={'preview_id': prepared['preview_id']})
    result = response.json()
    assert result['dataset_group'] == 'FBroker' and result['coverage']['total'] == 1
    assert all(source['conversation_id'] == 'k1' for action in result['recommendations'] for source in action['sources'])
    invalid = client.post('/api/assistant/filter', headers=SUP, json={'dataset_group': 'MISSING'})
    assert invalid.status_code == 422

"""Exercise legacy workflow tests through the production preview gate (no bypass)."""
from urllib.parse import urlsplit, parse_qs
from fastapi.testclient import TestClient


class PreviewClient(TestClient):
    def post(self, url, **kwargs):
        parsed = urlsplit(str(url))
        payload = kwargs.get('json') or {}
        headers = dict(kwargs.get('headers') or {})
        spec = None
        if parsed.path.startswith('/api/evaluate/'):
            spec = {'purpose': 'evaluation', 'conversation_id': parsed.path.split('/')[-1],
                    'force': parse_qs(parsed.query).get('force', ['false'])[0] == 'true'}
        elif parsed.path == '/api/evaluate-batch':
            spec = {'purpose': 'batch', 'conversation_ids': payload.get('conversation_ids', [])}
        elif parsed.path.startswith('/api/practice/'):
            parts = parsed.path.split('/')
            spec = {'purpose': 'practice', 'conversation_id': parts[-2], 'criterion_id': parts[-1],
                    'answer': payload.get('answer'), 'language': payload.get('language', 'ru')}
        if spec and not payload.get('preview_id') and 'X-AI-Preview' not in headers:
            preview = super().post('/api/ai/prepare', json=spec, headers=headers)
            if preview.status_code == 200:
                headers['X-AI-Preview'] = preview.json()['preview_id']
                kwargs['headers'] = headers
        return super().post(url, **kwargs)

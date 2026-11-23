from types import SimpleNamespace
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.services import jenny_voice


def client_with(monkeypatch, configured=True, upstream=None):
    monkeypatch.setattr(jenny_voice, "get_settings", lambda: SimpleNamespace(
        elevenlabs_api_key="test-key" if configured else "", elevenlabs_voice_id="test-voice" if configured else ""))
    jenny_voice._cache.clear()
    if upstream:
        original = httpx.AsyncClient
        monkeypatch.setattr(jenny_voice.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(upstream)))
    app = FastAPI()
    app.include_router(jenny_voice.router)
    return TestClient(app)


def test_unconfigured_uses_explicit_unavailable_state(monkeypatch):
    with client_with(monkeypatch, configured=False) as client:
        assert client.get('/jenny/voice/status').json() == {'provider': 'elevenlabs', 'configured': False}
        assert client.post('/jenny/voice', json={'text': 'Hello'}).status_code == 503


def test_generated_speech_is_cached(monkeypatch):
    calls = []
    def upstream(request):
        calls.append(request)
        assert request.headers['xi-api-key'] == 'test-key'
        return httpx.Response(200, content=b'example-mp3')
    with client_with(monkeypatch, upstream=upstream) as client:
        for _ in range(2):
            response = client.post('/jenny/voice', json={'text': 'Hello Sarah'})
            assert response.status_code == 200
            assert response.content == b'example-mp3'
            assert response.headers['content-type'] == 'audio/mpeg'
    assert len(calls) == 1


def test_provider_failure_does_not_expose_provider_body(monkeypatch):
    with client_with(monkeypatch, upstream=lambda request: httpx.Response(401, text='secret provider data')) as client:
        response = client.post('/jenny/voice', json={'text': 'Hello'})
        assert response.status_code == 502
        assert 'secret' not in response.text

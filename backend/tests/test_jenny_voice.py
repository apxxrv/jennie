import io
from types import SimpleNamespace

import httpx
from botocore.exceptions import ClientError
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services import jenny_voice


def fake_settings(elevenlabs=False, tts_provider="cartesia", mock_cartesia=True):
    return SimpleNamespace(
        elevenlabs_api_key="test-key" if elevenlabs else "", elevenlabs_voice_id="test-voice" if elevenlabs else "",
        tts_provider=tts_provider, mock_cartesia=mock_cartesia,
        polly_voice_id="Danielle", polly_engine="generative", polly_vendor_voice_id="Stephen",
        aws_profile="", aws_region="us-east-1")


def client_with(monkeypatch, configured=True, upstream=None, settings=None):
    monkeypatch.setattr(jenny_voice, "get_settings", lambda: settings or fake_settings(elevenlabs=configured))
    jenny_voice._cache.clear()
    if upstream:
        original = httpx.AsyncClient
        monkeypatch.setattr(jenny_voice.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(upstream)))
    app = FastAPI()
    app.include_router(jenny_voice.router)
    return TestClient(app)


class FakePolly:
    """Stands in for the boto3 Polly client: records each request, answers with fake MP3 bytes, and can refuse an engine."""

    def __init__(self, unsupported=()):
        self.calls = []
        self.unsupported = set(unsupported)  # (voice, engine) pairs that raise like Polly does

    def synthesize_speech(self, **kwargs):
        self.calls.append(kwargs)
        if (kwargs["VoiceId"], kwargs["Engine"]) in self.unsupported:
            raise ClientError({"Error": {"Code": "ValidationException", "Message": "engine not supported"}}, "SynthesizeSpeech")
        return {"AudioStream": io.BytesIO(f"mp3:{kwargs['VoiceId']}:{kwargs['Engine']}".encode())}


def polly_client(monkeypatch, polly):
    monkeypatch.setattr(jenny_voice.call_voice, "polly_client", lambda settings: polly)
    return client_with(monkeypatch, settings=fake_settings(tts_provider="polly", mock_cartesia=False))


def test_unconfigured_uses_explicit_unavailable_state(monkeypatch):
    with client_with(monkeypatch, configured=False) as client:
        assert client.get('/jenny/voice/status').json() == {'provider': None, 'configured': False}
        assert client.post('/jenny/voice', json={'text': 'Hello'}).status_code == 503


def test_polly_selected_but_mocked_stays_unavailable(monkeypatch):
    with client_with(monkeypatch, settings=fake_settings(tts_provider="polly", mock_cartesia=True)) as client:
        assert client.get('/jenny/voice/status').json() == {'provider': None, 'configured': False}
        assert client.post('/jenny/voice', json={'text': 'Hello'}).status_code == 503


def test_elevenlabs_status(monkeypatch):
    with client_with(monkeypatch, configured=True) as client:
        assert client.get('/jenny/voice/status').json() == {'provider': 'elevenlabs', 'configured': True}


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


def test_polly_status_and_agent_voice(monkeypatch):
    polly = FakePolly()
    with polly_client(monkeypatch, polly) as client:
        assert client.get('/jenny/voice/status').json() == {'provider': 'polly', 'configured': True}
        response = client.post('/jenny/voice', json={'text': 'Hello, this is Jenny.'})
        assert response.status_code == 200
        assert response.headers['content-type'] == 'audio/mpeg'
        assert response.content == b'mp3:Danielle:generative'
    assert polly.calls == [{'Text': 'Hello, this is Jenny.', 'OutputFormat': 'mp3', 'VoiceId': 'Danielle', 'Engine': 'generative'}]


def test_polly_vendor_voice_falls_back_to_neural(monkeypatch):
    polly = FakePolly(unsupported={('Stephen', 'generative')})
    with polly_client(monkeypatch, polly) as client:
        response = client.post('/jenny/voice', json={'text': 'No, we never changed banks.', 'speaker': 'vendor'})
        assert response.status_code == 200
        assert response.content == b'mp3:Stephen:neural'
    assert [(c['VoiceId'], c['Engine']) for c in polly.calls] == [('Stephen', 'generative'), ('Stephen', 'neural')]


def test_polly_cache_keeps_speakers_apart(monkeypatch):
    polly = FakePolly()
    with polly_client(monkeypatch, polly) as client:
        for speaker in ('agent', 'vendor', 'agent', 'vendor'):
            assert client.post('/jenny/voice', json={'text': 'Thank you.', 'speaker': speaker}).status_code == 200
    assert [c['VoiceId'] for c in polly.calls] == ['Danielle', 'Stephen']


def test_polly_failure_is_502_and_speaker_is_validated(monkeypatch):
    class Broken(FakePolly):
        def synthesize_speech(self, **kwargs):
            raise ClientError({"Error": {"Code": "AccessDeniedException", "Message": "secret detail"}}, "SynthesizeSpeech")
    with polly_client(monkeypatch, Broken()) as client:
        response = client.post('/jenny/voice', json={'text': 'Hello'})
        assert response.status_code == 502
        assert 'secret' not in response.text
        assert client.post('/jenny/voice', json={'text': 'Hello', 'speaker': 'attacker'}).status_code == 422
        assert client.post('/jenny/voice', json={'text': 'x' * 1201}).status_code == 422

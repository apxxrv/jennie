"""CLAUDE_PROVIDER=bedrock and TTS_PROVIDER=polly, without the network."""

import io
import wave

import anthropic
import pytest

from app.config import Settings, get_settings
from app.services import voice
from app.services.llm import claude_client


@pytest.fixture
def bedrock(monkeypatch):
    monkeypatch.setenv("CLAUDE_PROVIDER", "bedrock")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("AWS_PROFILE", "")
    # Fake static credentials so the Bedrock client never looks for a real AWS profile.
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_bedrock_rewrites_bare_model_ids_and_needs_no_key(bedrock):
    s = get_settings()
    assert s.anthropic_api_key == ""
    assert s.claude_model_main == "us.anthropic.claude-sonnet-5-5"
    assert s.claude_model_fast == "us.anthropic.claude-haiku-5-5"
    assert s.claude_ready


def test_bedrock_prefix_and_full_ids_left_alone(monkeypatch):
    s = Settings(claude_provider="bedrock", bedrock_inference_prefix="global", claude_model_main="claude-opus-5-5",
                 claude_model_fast="us.anthropic.claude-haiku-5-5", anthropic_api_key="")
    assert s.claude_model_main == "global.anthropic.claude-opus-5-5"
    assert s.claude_model_fast == "us.anthropic.claude-haiku-5-5"


def test_anthropic_provider_unchanged():
    s = Settings(claude_provider="anthropic", claude_model_main="claude-sonnet-5-5", anthropic_api_key="")
    assert s.claude_model_main == "claude-sonnet-5-5"
    assert not s.claude_ready
    assert Settings(anthropic_api_key="sk-test").claude_ready


def test_claude_client_is_bedrock(bedrock):
    client = claude_client(timeout=3, max_retries=0)
    assert isinstance(client, anthropic.AnthropicBedrock)
    assert client.max_retries == 0


def test_claude_client_is_anthropic_by_default():
    assert isinstance(claude_client(), anthropic.Anthropic)


def test_polly_wav_is_16k_mono_16bit(monkeypatch):
    pcm = b"\x01\x00" * 8000  # half a second of 16 kHz 16-bit mono
    calls = []

    class FakePolly:
        def synthesize_speech(self, **kw):
            calls.append(kw)
            return {"AudioStream": io.BytesIO(pcm)}

    s = Settings(tts_provider="polly", polly_voice_id="Matthew", polly_engine="neural", aws_profile="", aws_region="us-east-1")
    monkeypatch.setitem(voice._polly_client_cache, (s.aws_profile, s.aws_region), FakePolly())
    data = voice._polly_wav("This is an automated call.", s)
    assert calls == [{"Text": "This is an automated call.", "OutputFormat": "pcm", "SampleRate": "16000", "VoiceId": "Matthew", "Engine": "neural"}]
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, 16000, 8000)

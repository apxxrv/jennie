"""Speech for the browser's Jenny call view. ElevenLabs when it is configured; otherwise AWS Polly when the app's call voice is real
Polly, so the browser hears the same voice as the phone. Anything else answers 503 and the browser shows the text only."""
import asyncio
import hashlib
from collections import OrderedDict
from typing import Literal, Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.services import voice as call_voice

router = APIRouter(prefix="/jenny", tags=["Jenny voice"])
_cache: OrderedDict[str, bytes] = OrderedDict()
Provider = Literal["elevenlabs", "polly"]


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)
    speaker: Literal["agent", "vendor"] = "agent"


def _provider(settings: Settings) -> Optional[Provider]:
    if settings.elevenlabs_api_key and settings.elevenlabs_voice_id:
        return "elevenlabs"
    if settings.tts_provider == "polly" and not settings.mock_cartesia:
        return "polly"
    return None


@router.get("/voice/status")
def voice_status() -> dict:
    provider = _provider(get_settings())
    return {"provider": provider, "configured": provider is not None}


def _polly_mp3(text: str, voice_id: str, engine: str, settings: Settings) -> bytes:
    """MP3 from Polly. A voice that lacks the configured engine is retried once with the neural engine."""
    from botocore.exceptions import ClientError

    client = call_voice.polly_client(settings)
    try:
        resp = client.synthesize_speech(Text=text, OutputFormat="mp3", VoiceId=voice_id, Engine=engine)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if engine == "neural" or code not in ("EngineNotSupportedException", "ValidationException"):
            raise
        resp = client.synthesize_speech(Text=text, OutputFormat="mp3", VoiceId=voice_id, Engine="neural")
    with resp["AudioStream"] as stream:
        return stream.read()


async def _elevenlabs(text: str, settings: Settings) -> bytes:
    try:
        async with httpx.AsyncClient(timeout=35) as client:
            result = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{settings.elevenlabs_voice_id}",
                params={"output_format": "mp3_44100_128"},
                headers={"xi-api-key": settings.elevenlabs_api_key},
                json={"text": text, "model_id": "eleven_multilingual_v2"},
            )
    except httpx.HTTPError:
        raise HTTPException(502, "ElevenLabs could not be reached.")
    if result.status_code != 200:
        raise HTTPException(502, "ElevenLabs could not generate this clip.")
    return result.content


@router.post("/voice")
async def voice(body: SpeechRequest) -> Response:
    settings = get_settings()
    provider = _provider(settings)
    if provider is None:
        raise HTTPException(503, "No voice is connected. The browser shows the text only.")
    if provider == "elevenlabs":
        voice_id = settings.elevenlabs_voice_id
    else:
        voice_id = settings.polly_voice_id if body.speaker == "agent" else settings.polly_vendor_voice_id
    key = hashlib.sha256(f"{provider}\n{voice_id}\n{body.speaker}\n{body.text}".encode()).hexdigest()
    if key in _cache:
        _cache.move_to_end(key)
        return Response(_cache[key], media_type="audio/mpeg")
    if provider == "elevenlabs":
        audio = await _elevenlabs(body.text, settings)
    else:
        try:
            audio = await asyncio.to_thread(_polly_mp3, body.text, voice_id, settings.polly_engine, settings)
        except Exception:  # noqa: BLE001  any Polly or credential failure; the browser falls back to text
            raise HTTPException(502, "Polly could not generate this clip.")
    _cache[key] = audio
    if len(_cache) > 32:
        _cache.popitem(last=False)
    return Response(audio, media_type="audio/mpeg")

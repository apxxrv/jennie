"""Optional ElevenLabs speech for the explicit, browser-only Jenny demo."""
import hashlib
from collections import OrderedDict
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from app.config import get_settings

router = APIRouter(prefix="/jenny", tags=["Jenny voice"])
_cache: OrderedDict[str, bytes] = OrderedDict()

class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)

@router.get("/voice/status")
def voice_status():
    settings = get_settings()
    return {"provider": "elevenlabs", "configured": bool(settings.elevenlabs_api_key and settings.elevenlabs_voice_id)}

@router.post("/voice")
async def voice(body: SpeechRequest):
    settings = get_settings()
    if not settings.elevenlabs_api_key or not settings.elevenlabs_voice_id:
        raise HTTPException(503, "ElevenLabs is not connected. The browser can use bundled demo audio.")
    key = hashlib.sha256((settings.elevenlabs_voice_id + body.text).encode()).hexdigest()
    if key in _cache:
        _cache.move_to_end(key)
        return Response(_cache[key], media_type="audio/mpeg")
    try:
        async with httpx.AsyncClient(timeout=35) as client:
            result = await client.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{settings.elevenlabs_voice_id}",
                params={"output_format": "mp3_44100_128"},
                headers={"xi-api-key": settings.elevenlabs_api_key},
                json={"text": body.text, "model_id": "eleven_multilingual_v2"},
            )
        if result.status_code != 200:
            raise HTTPException(502, "ElevenLabs could not generate this clip.")
    except httpx.HTTPError:
        raise HTTPException(502, "ElevenLabs could not be reached.")
    _cache[key] = result.content
    if len(_cache) > 32:
        _cache.popitem(last=False)
    return Response(result.content, media_type="audio/mpeg")

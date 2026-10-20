"""Голос: распознавание запроса (Groq Whisper) и озвучка ответа (ElevenLabs)."""
import os

import requests

from . import config
from .recommend import _client

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
# Sarah — мультиязычный голос по умолчанию в ElevenLabs.
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")
ELEVENLABS_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_multilingual_v2")


def transcribe(audio: bytes, filename: str = "query.wav") -> str:
    lang = os.getenv("STT_LANGUAGE") or None  # пусто — Whisper определит язык сам
    resp = _client().audio.transcriptions.create(
        file=(filename, audio), model=config.STT_MODEL, language=lang, response_format="text",
    )
    return (resp if isinstance(resp, str) else resp.text).strip()


def tts_available() -> bool:
    return bool(ELEVENLABS_API_KEY)


def speak(text: str) -> bytes:
    """MP3 с озвученным текстом."""
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}",
        params={"output_format": "mp3_44100_128"},
        headers={"xi-api-key": ELEVENLABS_API_KEY},
        json={"text": text, "model_id": ELEVENLABS_MODEL},
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"ElevenLabs вернул {resp.status_code}: {resp.text[:200]}")
    return resp.content


def answer_to_speech_text(result: dict) -> str:
    """Короткий текст для озвучки: вступление и по фразе на каждое место."""
    unit = {"en": "minutes away", "kk": "минут"}.get(result["intent"]["language"], "минут")
    parts = [result.get("intro") or ""]
    for i, it in enumerate(result.get("items", []), 1):
        minutes = it.get("leg", {}).get("travel_min", it["travel_min"])
        parts.append(f"{i}. {it['name']}, {minutes} {unit}. {it.get('why') or ''}")
    return " ".join(p for p in parts if p).strip()

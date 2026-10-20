"""«Что это за место?» — узнаём место по фото (модель Groq с поддержкой изображений).

Модель не угадывает вслепую: она выбирает из заметных мест рядом с человеком, у каждого — короткая
подсказка из описания 2ГИС. Сначала описывает, что видит, потом выбирает: так ошибок меньше
(без этого модель путала Хан Шатыр с Дворцом мира и согласия). Фото нигде не сохраняется.
"""
import base64
import json
import os
import random
import re
from datetime import datetime

from .categories import LABELS
from .poi import hours_today, open_status
from .recommend import _client, distance_m, load_pois

VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b")
LANDMARKS = {"sight", "viewpoint", "museum", "mall", "park", "theatre", "gallery"}
RADIUS_M = 2500
MAX_CANDIDATES = 25  # меньше токенов: у модели с картинками маленький лимит в минуту

# Подсказка про формы нужна: без неё модель называла конус Хан Шатыра «пирамидой» и выбирала Дворец мира.
PROMPT = """Определи, какое место Астаны на фото. Сначала опиши, что видишь: общая форма здания (конус/шатёр с круглым
основанием, пирамида с плоскими гранями, башня, купол, арка...), материал, цвет, детали. Потом сравни с описаниями мест
рядом с человеком:
{listing}
Верни JSON в таком порядке полей:
{{"seen": "что видно на фото, одна фраза до 25 слов", "ref": "ref лучшего варианта или null",
 "confidence": число от 0 до 1, "alternatives": ["ref других мест, которые тоже могут быть на фото, до 2"]}}
Выбирай ref, только если на фото именно это место. Если ни одно не подходит — ref = null."""


VIBE_PROMPT = """На фото — место, атмосферу которого человек хочет найти в Астане (это может быть
картинка из интернета). Опиши атмосферу и составь поисковый запрос для похожего места.
Верни JSON: {"vibe": "атмосфера одной фразой до 20 слов",
 "query": "запрос на русском до 20 слов: тип места и особенности (вид, терраса, тишина, зелень, интерьер, для кого)"}
Не придумывай названия заведений."""

def _ask(prompt: str, image: bytes, mime: str, max_tokens: int = 300) -> dict:
    data_url = f"data:{mime or 'image/jpeg'};base64,{base64.b64encode(image).decode()}"
    resp = _client().with_options(max_retries=1).chat.completions.create(
        model=VISION_MODEL, temperature=0, max_completion_tokens=max_tokens,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]}],
    )
    return json.loads(resp.choices[0].message.content)


def describe_vibe(image: bytes, mime: str) -> dict:
    """«Как на фото»: атмосфера картинки -> текстовый запрос для обычного подбора мест."""
    raw = _ask(VIBE_PROMPT, image, mime, 200)
    query = str(raw.get("query") or "").strip()[:200]
    if not query:
        raise ValueError("Не получилось понять, что на фото")
    return {"vibe": str(raw.get("vibe") or "").strip()[:200], "query": query}


def verify_checkin(image: bytes, mime: str, place: dict, now: datetime) -> dict:
    """Фото-отметка в квесте: на снимке действительно эта точка?

    Проверка вслепую: модели не говорим, какое место ждём, — она определяет его среди этой точки
    и заметных мест вокруг. Если сказать «это Байтерек», модель соглашается даже на фото Хан Шатыра.
    """
    cands = candidates(place["lat"], place["lon"])
    if all(c["id"] != place["id"] for c in cands):
        cands = cands[:MAX_CANDIDATES - 1]
        cands.insert(random.randrange(len(cands) + 1), place)  # случайная позиция: порядок не подсказывает ответ
    res = identify(image, mime, place["lat"], place["lon"], now, cands=cands)
    got = res["place"]
    # Одно и то же место бывает в 2ГИС дважды (памятник и организация) — сверяем и по расстоянию.
    match = bool(got) and (got["id"] == place["id"] or distance_m(got["lat"], got["lon"], place["lat"], place["lon"]) < 150)
    if match:
        comment = f"Узнал: {place['name']}."
    elif got:
        comment = f"На фото, похоже, {got['name']}, а не эта точка"
    else:
        comment = "Не узнал эту точку на фото"
    return {"match": match, "confidence": res["confidence"], "seen": res["seen"], "comment": comment}


def _hint(p: dict) -> str:
    d = (p["description"] or "").strip()
    first = re.split(r"(?<=[.!?])\s", d)[0][:80] if d else ""
    return f" — {first}" if first else ""


def candidates(lat: float, lon: float) -> list[dict]:
    _, pois = load_pois()
    near = [p for p in pois if LANDMARKS & set(p["categories"]) and distance_m(lat, lon, p["lat"], p["lon"]) < RADIUS_M]
    # Сначала места с описанием (по нему модель сверяется), потом самые известные.
    near.sort(key=lambda p: (p["description"] is None, -p["reviews"]))
    return near[:MAX_CANDIDATES]


def identify(image: bytes, mime: str, lat: float, lon: float, now: datetime, cands: list[dict] | None = None) -> dict:
    cands = cands if cands is not None else candidates(lat, lon)
    if not cands:
        return {"seen": None, "confidence": 0, "place": None, "alternatives": []}
    listing = "\n".join(f"c{i}: {p['name']} ({LABELS[p['categories'][0]]}){_hint(p)}" for i, p in enumerate(cands, 1))
    raw = _ask(PROMPT.format(listing=listing), image, mime)

    def pick(ref) -> dict | None:
        ref = str(ref or "")
        i = int(ref[1:]) - 1 if re.fullmatch(r"c\d+", ref) else -1
        return cands[i] if 0 <= i < len(cands) else None

    def view(p: dict) -> dict:
        status = open_status(p["schedule"], now)
        return {
            "id": p["id"], "name": p["name"], "lat": p["lat"], "lon": p["lon"], "url": p["url"],
            "category": p["categories"][0], "rating": p["rating"], "reviews": p["reviews"],
            "description": p["description"], "address": p["address"],
            "distance_m": round(distance_m(lat, lon, p["lat"], p["lon"])),
            "outdoor": p["schedule"] is None, "open_now": status["open"], "hours_today": hours_today(p["schedule"], now),
        }

    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence") or 0)))
    except (TypeError, ValueError):
        confidence = 0.0
    best = pick(raw.get("ref"))
    place = view(best) if best and confidence >= 0.5 else None
    # Похожие варианты — чтобы человек мог поправить модель одним нажатием. Дубли одного объекта
    # (Хан-Шатыр и ТРЦ Хан Шатыр) убираем по близости.
    alts = []
    for ref in (raw.get("alternatives") or [])[:3]:
        p = pick(ref)
        if p and p is not best and all(distance_m(p["lat"], p["lon"], q["lat"], q["lon"]) > 150 for q in [best, *alts] if q):
            alts.append(p)
    return {"seen": raw.get("seen"), "confidence": round(confidence, 2), "place": place,
            "alternatives": [view(p) for p in alts[:2]]}

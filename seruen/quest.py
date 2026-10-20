"""Квест-прогулка: 2–4 точки рядом, на каждой задание и вопрос.

Точки выбирает код (рядом, открыто, интересно, по пути), реальный маршрут строит 2ГИС.
Модель пишет задания и вопросы только по описаниям мест из 2ГИС; правильный вариант
она ставит первым, а порядок перемешиваем мы — так ответ проверяется без доверия к модели.
"""
import json
import random
import uuid
from datetime import datetime

from .categories import LABELS
from .recommend import (LANGUAGE_NAMES, WEEKDAYS_RU, Intent, _chat_json, _norm, attach_routes,
                        distance_m, retrieve, status_text)
from . import config

QUEST_CATEGORIES = ["sight", "viewpoint", "park", "museum"]
# Две записи об одном объекте (Байтерек-памятник и Байтерек-организация) — одна точка.
MIN_GAP_M = 150
POINTS_CHECKIN, POINTS_ANSWER, POINTS_FINISH = 50, 50, 100

QUEST_PROMPT = """Ты придумываешь короткий городской квест по Астане для прогулки пешком.
Тебе дают точки маршрута с данными из 2ГИС. Верни JSON:
{{
 "title": "название квеста, 2–5 слов, без пафоса и восклицательных знаков",
 "intro": "одно предложение: что за прогулка получится",
 "stops": [{{"ref": "s1",
   "task": "задание на месте: что найти, рассмотреть или сделать — одно конкретное предложение",
   "question": "вопрос, ответ на который есть в description этой точки; null, если description нет",
   "options": ["правильный ответ", "правдоподобный неправильный", "правдоподобный неправильный"],
   "fact": "короткий факт из description, который человек узнает после ответа; null, если description нет"}}]
}}
Правила:
- Вопросы и факты — только по description точки. Никаких сведений извне данных.
- Задание не должно подсказывать ответ на вопрос этой же точки (не называй в задании год, число, имя из ответа).
- В options первым всегда идёт правильный ответ, порядок мы перемешаем сами. Варианты короткие.
  В неправильных вариантах не используй имена политиков и религиозных деятелей.
- Если description нет: question, options и fact = null, а задание — на наблюдение (найти табличку,
  посчитать что-то видимое, выбрать лучший ракурс для фото).
- Пиши просто, как друг, который хорошо знает город. Не используй слова «идеально», «насладиться»,
  «незабываемый», «окунуться», «уникальный», «атмосферный», «уютный».
- Язык: {language}."""


def pick_stops(origin: dict, candidates: list[dict], n: int, max_walk_m: float) -> list[dict]:
    """Из самых интересных кандидатов (с описанием — в приоритете) каждый раз берём ближайший
    к текущей точке, пока не наберём n точек или не упрёмся в длину прогулки."""
    pool = sorted(candidates, key=lambda c: c["score"] + (1.0 if c["description"] else 0), reverse=True)[:10]
    stops, cur, walked = [], (origin["lat"], origin["lon"]), 0.0
    while pool and len(stops) < n:
        nxt = min(pool, key=lambda c: distance_m(*cur, c["lat"], c["lon"]))
        pool.remove(nxt)
        if any(distance_m(s["lat"], s["lon"], nxt["lat"], nxt["lon"]) < MIN_GAP_M for s in stops):
            continue
        step = distance_m(*cur, nxt["lat"], nxt["lon"]) * 1.3
        if stops and walked + step > max_walk_m:
            continue
        stops.append(nxt)
        walked += step
        cur = (nxt["lat"], nxt["lon"])
    return stops


def _walk_order(origin: dict, stops: list[dict]) -> list[dict]:
    """Порядок обхода: каждый раз к ближайшей ещё не пройденной точке."""
    out, cur, rest = [], (origin["lat"], origin["lon"]), list(stops)
    while rest:
        nxt = min(rest, key=lambda c: distance_m(*cur, c["lat"], c["lon"]))
        rest.remove(nxt)
        out.append(nxt)
        cur = (nxt["lat"], nxt["lon"])
    return out


def _quiz(raw: dict, rng: random.Random) -> dict:
    """Проверяет вопрос модели и перемешивает варианты. Плохой вопрос — без вопроса."""
    q, opts = raw.get("question"), raw.get("options")
    if not q or not isinstance(opts, list) or len(opts) != 3 or not all(isinstance(o, str) and o for o in opts):
        return {"question": None, "options": None, "answer": None}
    order = [0, 1, 2]
    rng.shuffle(order)
    return {"question": q, "options": [opts[i] for i in order], "answer": order.index(0)}


def build_quest(lat: float, lon: float, now: datetime, place: str | None = None, budget_min: int = 90,
                weather: dict | None = None, language: str = "ru") -> dict:
    origin = {"name": place or "ваша точка", "lat": lat, "lon": lon}
    intent = Intent(categories=QUEST_CATEGORIES, stroll=True, time_budget_min=budget_min, mode="walk")
    candidates, radius = retrieve(intent, lat, lon, now, limit=30, weather=weather)
    # Место, где человек уже стоит, точкой квеста не делаем.
    here = _norm(origin["name"])
    candidates = [c for c in candidates if not (here and c["distance_m"] < 150 and here in _norm(c["name"]))]
    # Вопрос можно составить только по описанию, поэтому точки с описанием — в первую очередь.
    max_walk = budget_min * 75 * 0.6
    rich = [c for c in candidates if c["description"]]
    stops = pick_stops(origin, rich, n=3, max_walk_m=max_walk) if len(rich) >= 2 else []
    if len(stops) < 3:
        extra = pick_stops(origin, [c for c in candidates if c not in stops], n=3 - len(stops), max_walk_m=max_walk)
        stops += [s for s in extra if all(distance_m(s["lat"], s["lon"], t["lat"], t["lon"]) >= MIN_GAP_M for t in stops)]
    stops = _walk_order(origin, stops)
    if len(stops) < 2:
        raise RuntimeError("Рядом мало интересных точек для квеста. Попробуйте другую точку — "
                           "например, Байтерек, Хан Шатыр или Экспо.")

    refs = {f"s{i}": s for i, s in enumerate(stops, 1)}
    payload = {"start": origin["name"], "now": f"{now:%d.%m.%Y %H:%M}, {WEEKDAYS_RU[now.weekday()]}",
               "weather": weather["label"] if weather else None,
               "stops": [{"ref": ref, "name": s["name"], "category": LABELS[s["main_category"]],
                          "rubrics": s["rubrics"][:4], "description": (s["description"] or "")[:700] or None}
                         for ref, s in refs.items()]}
    raw, model = _chat_json(config.RAG_MODEL, QUEST_PROMPT.format(language=LANGUAGE_NAMES.get(language, language)),
                            json.dumps(payload, ensure_ascii=False), effort="low")

    by_ref = {str(s.get("ref")): s for s in raw.get("stops") or []}
    rng = random.Random()
    out_stops = []
    for ref, s in refs.items():
        gen = by_ref.get(ref, {})
        quiz = _quiz(gen, rng) if s["description"] else {"question": None, "options": None, "answer": None}
        out_stops.append({
            "id": s["id"], "name": s["name"], "lat": s["lat"], "lon": s["lon"], "url": s["url"],
            "category": LABELS[s["main_category"]], "category_key": s["main_category"], "status": status_text(s),
            "task": gen.get("task") or "Найдите лучший ракурс и сделайте фото.",
            **quiz,
            "fact": (gen.get("fact") if quiz["question"] else None),
        })
    legs = attach_routes(origin, out_stops, "walk", chain=True)
    walk_min = sum(leg["travel_min"] for leg in legs)
    with_quiz = sum(1 for s in out_stops if s["question"])
    return {
        "id": uuid.uuid4().hex[:12],
        "title": raw.get("title") or "Прогулка рядом",
        "intro": raw.get("intro"),
        "origin": origin,
        "now": now.isoformat(timespec="minutes"),
        "weather": weather,
        "budget_min": budget_min,
        "stops": out_stops,
        "walk_distance_m": sum(leg["distance_m"] for leg in legs),
        "walk_min": walk_min,
        "points": {"checkin": POINTS_CHECKIN, "answer": POINTS_ANSWER, "finish": POINTS_FINISH,
                   "max": POINTS_CHECKIN * len(out_stops) + POINTS_ANSWER * with_quiz + POINTS_FINISH},
        "model": model,
    }

"""Данные для «Пульса города»: все места базы с расписанием в компактном виде.

Открыто ли место в выбранный час, браузер считает сам — так ползунок времени работает
мгновенно, без запросов к серверу.
"""
import math
from functools import lru_cache

from .poi import DAYS
from .recommend import OUTDOOR, load_pois

# Группы для цвета столбиков.
GROUPS = {
    "food": {"coffee", "cafe", "restaurant"},
    "night": {"bar", "nightclub", "karaoke"},
    "culture": {"museum", "gallery", "theatre", "cinema"},
    "city": {"sight", "viewpoint", "park"},
    "fun": {"kids", "quest", "bowling", "skating", "aquapark", "zoo", "anticafe"},
    "other": {"mall", "coworking", "bookstore"},
}


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _schedule(p: dict):
    """null — часы неизвестны, "out" — под открытым небом, "24" — круглосуточно,
    иначе 7 списков интервалов [с, до] в минутах (пн..вс)."""
    sch = p["schedule"]
    if sch is None:
        return "out" if OUTDOOR & set(p["categories"]) else None
    if sch.get("is_24x7"):
        return "24"
    return [[[_minutes(a), _minutes(b)] for a, b in sch.get(day, [])] for day in DAYS]


@lru_cache(maxsize=1)
def pulse_data() -> dict:
    meta, pois = load_pois()
    rows = []
    for p in pois:
        cat = p["categories"][0]
        group = next(g for g, cats in GROUPS.items() if cat in cats)
        # Популярность: число отзывов в логарифме, взвешенное рейтингом.
        popularity = round(math.log10(p["reviews"] + 1) * (p["rating"] or 4.0) / 5, 2)
        kind = "geo" if p["type"] == "attraction" else "firm"  # для ссылки на карточку в 2ГИС
        rows.append([p["id"], p["name"], round(p["lat"], 5), round(p["lon"], 5), cat, group, popularity,
                     _schedule(p), kind])
    return {"collected_at": meta["collected_at"][:10], "total": len(rows), "pois": rows}

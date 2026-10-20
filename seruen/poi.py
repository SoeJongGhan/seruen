"""Нормализация объектов 2ГИС и работа с расписанием."""
from datetime import datetime, timedelta, timezone

from .categories import classify

# С 1 марта 2024 года весь Казахстан живёт по UTC+5. Фиксированный сдвиг
# вместо zoneinfo, потому что на Windows нет системной базы часовых поясов.
ASTANA_TZ = timezone(timedelta(hours=5))
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def normalize(item: dict) -> dict | None:
    """Объект 2ГИС -> запись POI. None, если объект бесполезен (без имени, координат или категории)."""
    name = item.get("name")
    point = item.get("point")
    if not name or not point:
        return None
    rubrics = [r["name"] for r in item.get("rubrics", [])]
    categories = classify(rubrics, item.get("type"))
    if not categories:
        return None

    poi_id = item["id"].split("_")[0]
    reviews = item.get("reviews") or {}
    review_count = reviews.get("general_review_count") or 0
    attributes = sorted({
        a["name"].replace("\xa0", " ")
        for group in item.get("attribute_groups", [])
        for a in group.get("attributes", [])
    })
    kind = "geo" if item.get("type") == "attraction" else "firm"
    return {
        "id": poi_id,
        "name": name,
        "type": item.get("type"),
        "categories": categories,
        "rubrics": rubrics,
        "lat": point["lat"],
        "lon": point["lon"],
        "address": item.get("address_name") or item.get("full_address_name"),
        "description": (item.get("description") or "").strip() or None,
        "attributes": attributes,
        "schedule": compact_schedule(item.get("schedule")),
        # У достопримечательностей 2ГИС ставит 5.0 без единого отзыва — это не рейтинг.
        "rating": reviews.get("general_rating") if review_count else None,
        "reviews": review_count,
        "url": f"https://2gis.kz/astana/{kind}/{poi_id}",
        "source": "2gis",
    }


def compact_schedule(schedule: dict | None) -> dict | None:
    """{"Mon": [["10:00", "22:00"]], ..., "is_24x7": bool}. День без записи — выходной."""
    if not schedule:
        return None
    out = {"is_24x7": bool(schedule.get("is_24x7"))}
    for day in DAYS:
        hours = (schedule.get(day) or {}).get("working_hours") or []
        if hours:
            out[day] = [[h["from"], h["to"]] for h in hours]
    if schedule.get("comment"):
        out["comment"] = schedule["comment"]
    return out


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def open_status(schedule: dict | None, when: datetime) -> dict:
    """Открыто ли место в момент `when` (время Астаны).

    {"open": True/False/None, "closes_in": минуты до закрытия или None}.
    None означает, что расписания нет и честно сказать нельзя.
    """
    if not schedule:
        return {"open": None, "closes_in": None}
    if schedule.get("is_24x7"):
        return {"open": True, "closes_in": None}

    now = when.astimezone(ASTANA_TZ)
    now_min = now.hour * 60 + now.minute
    today = DAYS[now.weekday()]
    yesterday = DAYS[(now.weekday() - 1) % 7]

    for start, end in schedule.get(today, []):
        s, e = _minutes(start), _minutes(end)
        if e <= s:  # работает за полночь
            e += 24 * 60
        if s <= now_min < e:
            return {"open": True, "closes_in": e - now_min}
    # Хвост вчерашней смены, перешедшей через полночь.
    for start, end in schedule.get(yesterday, []):
        s, e = _minutes(start), _minutes(end)
        if e <= s and now_min < e:
            return {"open": True, "closes_in": e - now_min}
    return {"open": False, "closes_in": None}


def hours_today(schedule: dict | None, when: datetime) -> str | None:
    if not schedule:
        return None
    if schedule.get("is_24x7"):
        return "круглосуточно"
    day = DAYS[when.astimezone(ASTANA_TZ).weekday()]
    hours = schedule.get(day)
    if not hours:
        return "сегодня выходной"
    return ", ".join(f"{s}–{e}" for s, e in hours)

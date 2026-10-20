"""Реальные маршруты 2ГИС: пешком и на машине (Routing API), на транспорте (Public Transport API).

Ответы кешируются на диске. Если 2ГИС недоступен, возвращается None и интерфейс
показывает оценку по прямой.
"""
import hashlib
import json
import re

import requests

from . import config

ROUTING_URL = "https://routing.api.2gis.com/routing/7.0.0/global"
TRANSIT_URL = "https://routing.api.2gis.com/public_transport/2.0"
CACHE = config.CACHE_DIR / "routes"
_COORD = re.compile(r"(-?\d+\.\d+) (-?\d+\.\d+)")
_session = requests.Session()  # keep-alive: три маршрута подряд не открывают три TLS-соединения


def _post(url: str, body: dict):
    """POST с коротким таймаутом на подключение и одним повтором: сеть бывает нестабильной."""
    for attempt in range(2):
        try:
            return _session.post(url, params={"key": config.DGIS_API_KEY}, json=body, timeout=(4, 10)).json()
        except (requests.ConnectionError, requests.Timeout):
            if attempt:
                raise


def _parse_wkt(wkt: str | None) -> list[list[float]]:
    """LINESTRING(lon lat, ...) -> [[lat, lon], ...] для folium."""
    return [[float(lat), float(lon)] for lon, lat in _COORD.findall(wkt or "")]


def _cached(key: dict, fetch) -> dict | None:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (hashlib.sha1(json.dumps(key, sort_keys=True).encode()).hexdigest() + ".json")
    if path.exists():
        return json.loads(path.read_text("utf-8"))
    try:
        result = fetch()
    except (requests.RequestException, KeyError, IndexError, ValueError):
        return None  # без ключа в сообщении: исключение requests содержит URL
    if result:
        path.write_text(json.dumps(result, ensure_ascii=False), "utf-8")
    return result


def _road(a, b, transport: str) -> dict | None:
    body = {"points": [{"type": "stop", "lat": a[0], "lon": a[1]}, {"type": "stop", "lat": b[0], "lon": b[1]}],
            "transport": transport, "output": "detailed", "locale": "ru"}
    j = _post(ROUTING_URL, body)
    if j.get("status") != "OK" or not j.get("result"):
        return None
    res = j["result"][0]
    line = _parse_wkt((res.get("begin_pedestrian_path") or {}).get("geometry", {}).get("selection"))
    for m in res.get("maneuvers", []):
        for seg in (m.get("outcoming_path") or {}).get("geometry", []):
            line += _parse_wkt(seg.get("selection"))
    line += _parse_wkt((res.get("end_pedestrian_path") or {}).get("geometry", {}).get("selection"))
    return {"distance_m": res["total_distance"], "duration_min": max(1, round(res["total_duration"] / 60)),
            "geometry": line, "summary": None}


def _transit(a, b) -> dict | None:
    body = {"source": {"point": {"lat": a[0], "lon": a[1]}}, "target": {"point": {"lat": b[0], "lon": b[1]}},
            "transport": ["bus", "trolleybus", "shuttle_bus", "light_metro"], "locale": "ru"}
    routes = _post(TRANSIT_URL, body)
    if not isinstance(routes, list) or not routes:
        return None
    best = min(routes, key=lambda r: r["total_duration"])
    line, rides = [], []
    for mv in best["movements"]:
        for alt in (mv.get("alternatives") or [])[:1]:
            for seg in alt.get("geometry") or []:
                line += _parse_wkt(seg.get("selection"))
        if mv.get("type") == "passage" and mv.get("routes"):
            r = mv["routes"][0]
            rides.append(f"{r.get('subtype_name', 'транспорт')} {', '.join(r.get('names', []))}")
    summary = " → ".join(rides) if rides else "пешком быстрее"
    if rides and best.get("total_walkway_distance"):
        summary += f" · {best['total_walkway_distance']}"
    return {"distance_m": best["total_distance"], "duration_min": max(1, round(best["total_duration"] / 60)),
            "geometry": line, "summary": summary}


def route(a: tuple[float, float], b: tuple[float, float], mode: str) -> dict | None:
    """Маршрут из точки a в точку b. mode: walk | car | transit."""
    if not config.DGIS_API_KEY:
        return None
    a, b = (round(a[0], 5), round(a[1], 5)), (round(b[0], 5), round(b[1], 5))
    key = {"a": a, "b": b, "mode": mode}
    if mode == "transit":
        return _cached(key, lambda: _transit(a, b))
    return _cached(key, lambda: _road(a, b, "driving" if mode == "car" else "walking"))


DIRECTIONS_TAB = {"walk": "pedestrian", "car": "car", "transit": "bus"}


def directions_url(points: list[tuple[float, float, str | None]], mode: str = "walk") -> str:
    """Ссылка «открыть маршрут в 2ГИС»: точки (lat, lon, id организации или None)."""
    parts = [f"{lon},{lat}" + (f";{pid}" if pid else "") for lat, lon, pid in points]
    return (f"https://2gis.kz/astana/directions/tab/{DIRECTIONS_TAB.get(mode, 'pedestrian')}/points/"
            + requests.utils.quote("|".join(parts), safe=""))

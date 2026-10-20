"""Автоматический сбор POI Астаны из 2ГИС в data/pois.json.

Запуск:  python -m seruen.collect [--max-requests 900] [--step 2500]

Плотные категории (кафе, парки, достопримечательности) собираются обходом города
сеткой точек, редкие (музеи, катки, квесты) — одним запросом на весь город.
Ответы кешируются в data/cache, поэтому повторный запуск бесплатен и продолжает
с места, где кончилась квота.
"""
import argparse
import json
import math
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from . import config
from .categories import CATEGORIES
from .dgis import DgisClient, NetworkError, QuotaExceeded
from .poi import normalize

CITY_CENTER = (51.13, 71.44)
CITY_RADIUS = 20_000
# Точки вне сетки, которые нужны сценариям: аэропорт («2 часа до вылета»).
EXTRA_POINTS = [(51.0222, 71.4669)]


def grid(bbox: dict, step_m: int):
    dlat = step_m / 111_320
    lat = bbox["lat_min"] + dlat / 2
    while lat < bbox["lat_max"]:
        dlon = step_m / (111_320 * math.cos(math.radians(lat)))
        lon = bbox["lon_min"] + dlon / 2
        while lon < bbox["lon_max"]:
            yield round(lat, 5), round(lon, 5)
            lon += dlon
        lat += dlat


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-requests", type=int, default=900, help="бюджет новых запросов к 2ГИС за запуск")
    ap.add_argument("--step", type=int, default=2500, help="шаг сетки в метрах")
    ap.add_argument("--workers", type=int, default=6, help="параллельных запросов")
    args = ap.parse_args()

    client = DgisClient(config.DGIS_API_KEY, config.CACHE_DIR, max_requests=args.max_requests)
    points = list(grid(config.ASTANA_BBOX, args.step)) + EXTRA_POINTS
    # Круг радиусом 0.75 шага накрывает квадратную ячейку сетки целиком.
    cell_radius = int(args.step * 0.75)

    def run(cat, query, lat, lon, radius):
        return list(client.search(query, lat, lon, radius, type=cat.type,
                                  sort=cat.sort, max_pages=cat.max_pages))

    pois: dict[str, dict] = {}
    stopped = None
    try:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for cat in CATEGORIES:
                if cat.scope == "grid":
                    searches = [(q, lat, lon, cell_radius) for q in (cat.query, *cat.also) for lat, lon in points]
                else:
                    searches = [(q, *CITY_CENTER, CITY_RADIUS) for q in (cat.query, *cat.also)]
                before = len(pois)
                for items in pool.map(lambda s: run(cat, *s), searches):
                    for item in items:
                        poi = normalize(item)
                        if poi and poi["id"] not in pois:
                            pois[poi["id"]] = poi
                print(f"{cat.key:<11} +{len(pois) - before:>4} мест   "
                      f"(запросов: {client.requests_made}, из кеша: {client.cache_hits})", flush=True)
    except (QuotaExceeded, NetworkError) as e:
        stopped = str(e)
        print(f"\nОстановлено: {stopped}. Собранное сохраняю; повторный запуск продолжит с этого места.")

    counts = Counter(c for p in pois.values() for c in p["categories"])
    out = {
        "meta": {
            "source": "2GIS Places API (catalog.api.2gis.com/3.0)",
            "collected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "bbox": config.ASTANA_BBOX,
            "grid_step_m": args.step,
            "complete": stopped is None,
            "total": len(pois),
            "by_category": dict(counts.most_common()),
        },
        "pois": list(pois.values()),
    }
    config.DATA_DIR.mkdir(exist_ok=True)
    config.POIS_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print(f"\nСохранено {len(pois)} мест -> {config.POIS_PATH}")
    print("По категориям:", ", ".join(f"{k}={v}" for k, v in counts.most_common()))


if __name__ == "__main__":
    main()

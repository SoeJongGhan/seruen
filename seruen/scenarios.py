"""Тестовые сценарии: из кейса Smart City плюс стретч-цели.

Запуск всех сценариев с сохранением результата в data/scenario_results.json:
    python -m seruen.scenarios            # все
    python -m seruen.scenarios 2 5        # выборочно
    python -m seruen.scenarios --pause 20 # пауза между сценариями (лимит Groq ~8000 токенов/мин)
"""
import json
import sys
import time
from datetime import datetime

from . import config
from .poi import ASTANA_TZ

SCENARIOS = [
    {
        "title": "Прогулка у Mega Silk Way", "chip": "Погулять у Mega Silk Way",
        "text": "Я сейчас возле Mega Silk Way, хочу прогуляться 30–60 минут — что посоветуете?",
        "origin": "Mega Silk Way", "when": "2026-10-20T18:00",
        "expect": "Прогулочные места в пешей доступности (парк, достопримечательности Экспо), кафе как остановка.",
    },
    {
        "title": "Тихое кафе с розеткой", "chip": "Кафе с розеткой",
        "text": "Хочу тихое место с кофе и розеткой недалеко от меня.",
        "origin": "Байтерек", "when": "2026-10-20T14:00",
        "expect": "Кофейни/антикафе рядом с атрибутом «можно с ноутбуком», открытые сейчас.",
    },
    {
        "title": "С ребёнком", "chip": "Куда с ребёнком",
        "text": "Еду с ребёнком — где рядом есть детские площадки или музей с интерактивами?",
        "origin": "Хан Шатыр", "when": "2026-10-24T11:00",
        "expect": "Детские центры и музеи, без выдуманных «интерактивов», если их нет в данных.",
    },
    {
        "title": "Турист, 2 часа до вылета", "chip": "2 часа до вылета",
        "text": "Я - турист, у меня 2 часа перед вылетом: что можно посмотреть поблизости?",
        "origin": "Байтерек", "when": "2026-10-20T15:00",
        "expect": "1–2 знаковых места рядом, с запасом времени на дорогу в аэропорт.",
    },
    {
        "title": "Ночная активность", "chip": "Что открыто ночью",
        "text": "Ищу необычную ночную активность (последние пару часов).",
        "origin": "Байтерек", "when": "2026-10-23T23:30",
        "expect": "Только места, открытые после полуночи (по расписанию), с предупреждением о закрытии.",
    },
    {
        "title": "Необычное у Экспо, пешком", "chip": "Необычное у Экспо",
        "text": "Я у здания Экспо 2017, хочу что-то необычное на 1–2 часа, пешком.",
        "origin": "Экспо (Нур Алем)", "when": "2026-10-20T16:00",
        "expect": "Необычные места рядом с Экспо с планом на 1–2 часа.",
    },
    {
        "title": "Мини-маршрут для компании", "chip": "Вечер с друзьями",
        "text": "Составь маршрут из трёх мест на вечер для компании из 4 друзей, пешком.",
        "origin": "Хан Шатыр", "when": "2026-10-23T19:00",
        "expect": "Ровно 3 места в порядке обхода, с отрезками пути.",
    },
    {
        "title": "English, iconic sights", "chip": "In English",
        "text": "I'm near Khan Shatyr and have about an hour. What iconic places can I see on foot?",
        "origin": "Хан Шатыр", "when": "2026-10-20T12:00",
        "expect": "Ответ на английском, знаковые места рядом.",
    },
    {
        "title": "Доступная среда", "chip": "Без ступенек",
        "text": "Я на коляске, нужен вход без ступенек. Куда сходить поесть и отдохнуть на час?",
        "origin": "Байтерек", "when": "2026-10-20T13:00",
        "expect": "Места с атрибутом доступного входа; если данных нет — честная оговорка.",
    },
]


def scenario_args(sc: dict) -> dict:
    lat, lon = config.LANDMARKS[sc["origin"]]
    when = datetime.fromisoformat(sc["when"]).replace(tzinfo=ASTANA_TZ)
    return {"text": sc["text"], "lat": lat, "lon": lon, "now": when, "place": sc["origin"]}


def main():
    from .recommend import recommend

    args = sys.argv[1:]
    pause = 0
    if "--pause" in args:
        k = args.index("--pause")
        pause = int(args[k + 1])
        del args[k:k + 2]
    only = set(args)
    results = []
    for i, sc in enumerate(SCENARIOS, 1):
        if only and str(i) not in only:
            continue
        if results and pause:
            time.sleep(pause)
        t = time.time()
        r = recommend(**scenario_args(sc))
        elapsed = round(time.time() - t, 1)
        print(f"\n### {i}. {sc['title']}  ({elapsed} с: {r['timings']}, {r.get('model')}, "
              f"кандидатов {len(r['candidates'])}, радиус {r['radius_m']} м)")
        print(f"> {sc['text']}")
        i_ = r["intent"]
        print(f"  намерение: cat={i_['categories']} needs={i_['needs']} kw={i_['keywords']} "
              f"budget={i_['time_budget_min']} mode={i_['mode']} stroll={i_['stroll']} route={i_['route']}")
        print(f"  {r['intro']}")
        for n, it in enumerate(r["items"], 1):
            status = "" if it["outdoor"] else {True: "открыто", False: "закрыто", None: "часы неизвестны"}[it["open_now"]]
            leg = it["leg"]
            way = f"{leg['distance_m']} м, {leg['travel_min']} мин ({'2ГИС' if leg['real'] else 'оценка'})"
            if leg["summary"]:
                way += f", {leg['summary']}"
            print(f"  {n}. {it['name']} — {way}; {status} ({it['hours_today']})")
            print(f"     почему: {it['why']}")
            print(f"     план: {it['plan']} [{it['visit_min']} мин]")
            if it.get("caveat"):
                print(f"     оговорка: {it['caveat']}")
        if r.get("weather"):
            print(f"  погода: {r['weather']['label']} — {r['weather']['advice']}")
        if r.get("idea"):
            print(f"  идея ИИ: {r['idea']}")
        for it in r["items"]:  # геометрия маршрута раздувает файл, для отчёта она не нужна
            it["leg"] = {k: v for k, v in it["leg"].items() if k != "geometry"}
        results.append({"scenario": sc, "elapsed_s": elapsed,
                        **{k: v for k, v in r.items() if k not in ("candidates", "legs")},
                        "candidates": [c["name"] for c in r["candidates"]]})

    out = config.DATA_DIR / "scenario_results.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1, default=str), "utf-8")
    print(f"\nСохранено -> {out}")


if __name__ == "__main__":
    main()

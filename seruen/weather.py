"""Погода в Астане (Open-Meteo, без ключа) и её влияние на рекомендации."""
from datetime import datetime, timezone
from functools import lru_cache

import requests

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# WMO weather codes -> (эмодзи, описание, осадки).
_CODES = [
    ({0}, "☀️", "ясно", False),
    ({1, 2}, "⛅", "переменная облачность", False),
    ({3}, "☁️", "пасмурно", False),
    ({45, 48}, "🌫️", "туман", False),
    ({51, 53, 55, 56, 57}, "🌦️", "морось", True),
    ({61, 63, 65, 66, 67, 80, 81, 82}, "🌧️", "дождь", True),
    ({71, 73, 75, 77, 85, 86}, "🌨️", "снег", True),
    ({95, 96, 99}, "⛈️", "гроза", True),
]

# Готовые состояния для демо: показать жюри, как меняется выдача.
PRESETS = {
    "☀️ +24°, ясно": {"temp": 24, "feels": 24, "wind": 3, "precip": 0.0, "code": 0},
    "🌧️ +9°, дождь": {"temp": 9, "feels": 5, "wind": 7, "precip": 2.0, "code": 63},
    "🥶 −25°, метель": {"temp": -25, "feels": -34, "wind": 14, "precip": 0.5, "code": 75},
}


def describe(w: dict) -> dict:
    """Дополняет сырые данные: подпись, эмодзи и вердикт для поиска."""
    emoji, text, wet = next(((e, t, p) for codes, e, t, p in _CODES if w["code"] in codes), ("🌡️", "", False))
    harsh = w["feels"] <= -10 or w["wind"] >= 10 or (wet and w["precip"] > 0.2)
    pleasant = not harsh and not wet and 12 <= w["feels"] <= 30
    if harsh:
        advice = "погода суровая — в приоритете места в помещении, на улице недолго"
    elif pleasant:
        advice = "погода отличная — хорошо погулять на улице"
    elif w["feels"] < 3:
        advice = "прохладно — прогулку лучше совместить с тёплым местом"
    else:
        advice = "погода нейтральная"
    label = (f"{emoji} {w['temp']:+.0f}°, ощущается {w['feels']:+.0f}°, ветер {w['wind']:.0f} м/с"
             + (f", {text}" if text else ""))
    return {**w, "emoji": emoji, "text": text, "harsh": harsh, "pleasant": pleasant,
            "advice": advice, "label": label}


@lru_cache(maxsize=64)
def _hourly(lat: float, lon: float, day: str) -> dict:
    params = {"latitude": lat, "longitude": lon, "timezone": "GMT", "wind_speed_unit": "ms",
              "hourly": "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
              "past_days": 7, "forecast_days": 16}
    return requests.get(FORECAST_URL, params=params, timeout=10).json()["hourly"]


def hourly(lat: float, lon: float) -> list[dict]:
    """Почасовой прогноз от вчера до недели вперёд — для «Пульса города» (время в UTC)."""
    now = datetime.now(timezone.utc)
    try:
        h = _hourly(round(lat, 1), round(lon, 1), now.strftime("%Y-%m-%d"))
    except (requests.RequestException, KeyError, ValueError):
        return []
    lo = (now.replace(minute=0, second=0, microsecond=0)).timestamp() - 86400
    hi = lo + 9 * 86400
    out = []
    for i, t in enumerate(h["time"]):
        ts = datetime.fromisoformat(t).replace(tzinfo=timezone.utc).timestamp()
        if lo <= ts <= hi:
            w = describe({"temp": h["temperature_2m"][i], "feels": h["apparent_temperature"][i],
                          "wind": h["wind_speed_10m"][i], "precip": h["precipitation"][i], "code": h["weather_code"][i]})
            out.append({"t": t, "temp": w["temp"], "feels": w["feels"], "emoji": w["emoji"], "text": w["text"],
                        "harsh": w["harsh"], "pleasant": w["pleasant"]})
    return out


def get_weather(lat: float, lon: float, when: datetime) -> dict | None:
    """Погода на нужный час (до 7 дней назад и 16 вперёд). None, если сервис недоступен."""
    utc = when.astimezone(timezone.utc)
    try:
        h = _hourly(round(lat, 1), round(lon, 1), utc.strftime("%Y-%m-%d"))
        i = h["time"].index(utc.strftime("%Y-%m-%dT%H:00"))
    except (requests.RequestException, KeyError, ValueError):
        return None
    return describe({"temp": h["temperature_2m"][i], "feels": h["apparent_temperature"][i],
                     "wind": h["wind_speed_10m"][i], "precip": h["precipitation"][i], "code": h["weather_code"][i]})

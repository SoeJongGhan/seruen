"""Seruen AI — веб-демо RAG-помощника по прогулкам в Астане.

Запуск:  streamlit run app.py
"""
import hashlib
from datetime import date, datetime, time

import folium
import streamlit as st
from streamlit_folium import st_folium
from streamlit_js_eval import get_geolocation

from seruen import config, routing, voice
from seruen.categories import LABELS
from seruen.poi import ASTANA_TZ
from seruen.recommend import MODES, NEEDS, load_pois, more, recommend
from seruen.scenarios import SCENARIOS
from seruen.weather import PRESETS, describe

TILES_2GIS = "https://tile{s}.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1"
MODE_ICON = {"walk": "🚶", "transit": "🚌", "car": "🚗"}
LEG_COLORS = ["#1f6feb", "#8250df", "#cf222e"]
WEATHER_AUTO = "Авто — прогноз Open-Meteo"

st.set_page_config(page_title="Seruen AI — прогулки по Астане", page_icon="🧭", layout="wide")

meta, pois = load_pois()
ss = st.session_state
ss.setdefault("origin", {"name": "Байтерек", "lat": config.LANDMARKS["Байтерек"][0],
                         "lon": config.LANDMARKS["Байтерек"][1]})
ss.setdefault("result", None)
ss.setdefault("run_now", False)
ss.setdefault("last_click", None)
ss.setdefault("last_audio", None)
ss.setdefault("geo_pending", False)
ss.setdefault("geo_msg", None)
ss.setdefault("tts", {})
# Текст из голосового ввода: значение поля можно менять только до его отрисовки.
if "pending_query" in ss:
    ss.query = ss.pop("pending_query")
    ss.run_now = True


def fmt_dist(m: int) -> str:
    return f"{m} м" if m < 1000 else f"{m / 1000:.1f} км"


def in_astana(lat: float, lon: float) -> bool:
    b = config.ASTANA_BBOX
    return b["lat_min"] - 0.1 <= lat <= b["lat_max"] + 0.1 and b["lon_min"] - 0.15 <= lon <= b["lon_max"] + 0.15


def on_landmark():
    lat, lon = config.LANDMARKS[ss.place]
    ss.origin = {"name": ss.place, "lat": lat, "lon": lon}


def on_example():
    sc = next((s for s in SCENARIOS if s["title"] == ss.get("example")), None)
    if not sc:
        return
    when = datetime.fromisoformat(sc["when"])
    lat, lon = config.LANDMARKS[sc["origin"]]
    ss.origin = {"name": sc["origin"], "lat": lat, "lon": lon}
    ss.place = sc["origin"]
    ss.query = sc["text"]
    ss.manual_time = True
    ss.manual_date, ss.manual_clock = when.date(), when.time()
    ss.run_now = True


# ---------- Боковая панель: контекст ----------
with st.sidebar:
    st.header("Где вы и когда")
    st.selectbox("Ориентир", list(config.LANDMARKS), key="place", on_change=on_landmark)
    if st.button("📍 Где я? (геолокация браузера)", width="stretch"):
        ss.geo_pending, ss.geo_msg = True, None
    if ss.geo_pending:
        loc = get_geolocation()
        if isinstance(loc, dict) and loc.get("coords"):
            ss.geo_pending = False
            lat, lon = loc["coords"]["latitude"], loc["coords"]["longitude"]
            if in_astana(lat, lon):
                ss.origin = {"name": "моё местоположение", "lat": round(lat, 3), "lon": round(lon, 3)}
                ss.result = None
                st.rerun()
            ss.geo_msg = "Вы сейчас не в Астане — база покрывает только Астану. Выберите ориентир или точку на карте."
        elif loc:
            ss.geo_pending, ss.geo_msg = False, "Браузер не дал доступ к геолокации."
        else:
            st.caption("Разрешите браузеру доступ к местоположению…")
    if ss.geo_msg:
        st.warning(ss.geo_msg)
    st.caption("…или кликните по карте.")
    st.markdown(f"**Точка:** {ss.origin['name']}")

    st.toggle("Задать время вручную (для демо)", key="manual_time")
    if ss.manual_time:
        ss.setdefault("manual_date", date.today())
        ss.setdefault("manual_clock", time(18, 0))
        st.date_input("Дата", key="manual_date")
        st.time_input("Время", key="manual_clock", step=900)

    st.header("Контекст")
    weather_choice = st.selectbox("Погода", [WEATHER_AUTO, *PRESETS],
                                  help="Пресеты — для демонстрации: как меняется выдача в мороз или дождь.")
    mode_choice = st.radio("Как передвигаетесь", ["из запроса", *[m["label"] for m in MODES.values()]],
                           horizontal=True)
    budget_choice = st.select_slider("Сколько есть времени, мин", ["из запроса", 30, 60, 90, 120, 180])
    group_size = st.slider("Сколько вас", 1, 8, 1)
    need_flags = {
        "kids": st.checkbox("С ребёнком"),
        "accessible": st.checkbox("Нужна доступная среда"),
        "laptop": st.checkbox("Нужно место с ноутбуком/розеткой"),
    }

    st.divider()
    st.caption(f"📚 База: **{meta['total']}** мест из 2ГИС, собрано {meta['collected_at'][:10]}. "
               f"Маршруты — 2ГИС Routing API, погода — Open-Meteo.")
    st.caption("🔒 Приватность: точка округляется до ~100 м, нигде не сохраняется и не уходит в LLM — "
               "модель видит только название точки и расстояния до мест.")


# ---------- Запрос ----------
st.title("🧭 Seruen AI")
st.markdown("Подскажу, куда сходить в Астане прямо сейчас — с учётом того, где вы, сколько у вас времени, "
            "какая погода и что работает. Каждое место — из базы 2ГИС, с маршрутом и объяснением «почему».")

st.pills("Примеры из кейса", [s["title"] for s in SCENARIOS], key="example", on_change=on_example)

with st.form("ask", border=False):
    c1, c2 = st.columns([5, 1], vertical_alignment="bottom")
    c1.text_input("Что хотите?", key="query",
                  placeholder="Например: хочу тихое место с кофе и розеткой недалеко")
    submitted = c2.form_submit_button("Подобрать", type="primary", width="stretch")

audio = st.audio_input("Или скажите голосом (любой язык)")
if audio is not None:
    raw = audio.getvalue()
    digest = hashlib.sha1(raw).hexdigest()
    if digest != ss.last_audio:
        ss.last_audio = digest
        with st.spinner("Распознаю речь (Whisper)…"):
            try:
                ss.pending_query = voice.transcribe(raw)
            except Exception as e:
                st.error(f"Не удалось распознать речь: {e}")
        if "pending_query" in ss:
            st.rerun()

if (submitted or ss.run_now) and ss.get("query", "").strip():
    ss.run_now = False
    now = (datetime.combine(ss.manual_date, ss.manual_clock).replace(tzinfo=ASTANA_TZ)
           if ss.manual_time else datetime.now(ASTANA_TZ))
    overrides = {
        "mode": next((k for k, m in MODES.items() if m["label"] == mode_choice), None),
        "time_budget_min": budget_choice if isinstance(budget_choice, int) else None,
        "group_size": group_size if group_size > 1 else None,
        "needs": [k for k, on in need_flags.items() if on],
    }
    weather = describe(PRESETS[weather_choice]) if weather_choice in PRESETS else None
    with st.spinner("Разбираю запрос → ищу в базе → подбираю → строю маршруты в 2ГИС…"):
        try:
            ss.result = recommend(ss.query, round(ss.origin["lat"], 3), round(ss.origin["lon"], 3), now=now,
                                  overrides=overrides, place=ss.origin["name"], weather=weather)
        except Exception as e:
            ss.result = None
            st.error(f"Не получилось подобрать места: {e}")

# ---------- Ответ ----------
r = ss.result
left, right = st.columns([3, 2], gap="large")

with left:
    if r:
        mode = r["intent"]["mode"]
        mode_label = MODES[mode]["label"]
        is_route = r["intent"]["route"]
        w = r.get("weather")
        st.caption((f"{w['label']} — {w['advice']}" if w else "Погода: нет данных")
                   + f" · {r['now'][11:16]} · старт: {r['origin']['name']}")
        if r.get("intro"):
            st.subheader(r["intro"])
        if not r["items"]:
            st.info("Подходящих открытых мест не нашлось. Попробуйте увеличить время, сменить точку или запрос.")

        for i, it in enumerate(r["items"], 1):
            leg = it["leg"]
            with st.container(border=True):
                st.markdown(f"#### {i}. {it['name']}")
                way = f"{MODE_ICON[mode]} {fmt_dist(leg['distance_m'])} · {leg['travel_min']} мин {mode_label}"
                way += " (маршрут 2ГИС)" if leg["real"] else " (оценка по прямой)"
                if is_route and i > 1:
                    way += " от предыдущей точки"
                if leg["summary"]:
                    way += f" · {leg['summary']}"
                st.markdown(way)
                facts = [LABELS[it["main_category"]]]
                if it["rating"]:
                    facts.append(f"★ {it['rating']} ({it['reviews']} отз.)")
                if it["outdoor"]:
                    facts.append("🌳 под открытым небом")
                elif it["open_now"] is None:
                    facts.append("⚪ часы работы неизвестны")
                elif it["closes_in"] is not None and it["closes_in"] < 90:
                    facts.append(f"🟡 закроется через {it['closes_in']} мин")
                else:
                    facts.append(f"🟢 открыто · сегодня {it['hours_today']}")
                st.caption(" · ".join(facts))
                st.markdown(f"**Почему:** {it['why']}")
                visit = f" _(~{it['visit_min']} мин)_" if it.get("visit_min") else ""
                st.markdown(f"**Что делать:** {it['plan']}{visit}")
                if it.get("caveat"):
                    st.warning(it["caveat"], icon="⚠️")
                start = (r["origin"]["lat"], r["origin"]["lon"], None)
                if is_route and i > 1:
                    prev = r["items"][i - 2]
                    start = (prev["lat"], prev["lon"], prev["id"])
                link = routing.directions_url([start, (it["lat"], it["lon"], it["id"])], mode)
                used = ", ".join(it["matched"][:4])
                st.caption(f"[Карточка в 2ГИС]({it['url']}) · [Маршрут в 2ГИС]({link})"
                           + (f" · совпало: {used}" if used else ""))

        if is_route and r["items"]:
            total = sum(it["leg"]["travel_min"] + (it.get("visit_min") or 0) for it in r["items"])
            chain = [(r["origin"]["lat"], r["origin"]["lon"], None),
                     *[(it["lat"], it["lon"], it["id"]) for it in r["items"]]]
            st.markdown(f"**🗺️ Маршрут из {len(r['items'])} мест:** ≈ {total} мин с дорогой и временем на местах. "
                        f"[Открыть весь маршрут в 2ГИС]({routing.directions_url(chain, mode)})")

        if r.get("idea"):
            st.info(f"💡 **Идея ИИ — не из базы 2ГИС.** {r['idea'].get('title', '')}: {r['idea'].get('text', '')}")

        b1, b2, _ = st.columns([1, 1, 2])
        if r["items"] and b1.button("🔁 Другие варианты", width="stretch"):
            with st.spinner("Подбираю другие места…"):
                try:
                    nxt = more(r)
                    if nxt["items"]:
                        ss.result = nxt
                        st.rerun()
                    st.info("Других подходящих мест рядом нет — попробуйте изменить запрос.")
                except Exception as e:
                    st.error(str(e))
        if r["items"] and voice.tts_available() and b2.button("🔊 Озвучить", width="stretch"):
            key = r["now"] + "|".join(r["shown"])
            if key not in ss.tts:
                with st.spinner("Озвучиваю (ElevenLabs)…"):
                    try:
                        ss.tts[key] = voice.speak(voice.answer_to_speech_text(r))
                    except Exception as e:
                        st.error(str(e))
            if key in ss.tts:
                st.audio(ss.tts[key], format="audio/mp3", autoplay=True)

        with st.expander("🔎 Как система пришла к ответу"):
            i_ = r["intent"]
            flags = (" · прогулка" if i_["stroll"] else "") + (" · маршрут" if i_["route"] else "")
            if i_["group_size"] > 1:
                flags += f" · компания из {i_['group_size']}"
            st.markdown("**1. Разбор запроса (LLM → структура)**")
            st.markdown(
                f"- категории: {', '.join(LABELS[c] for c in i_['categories']) or 'любые'}\n"
                f"- потребности: {', '.join(NEEDS[n][0] for n in i_['needs']) or 'нет'}\n"
                f"- время: {i_['time_budget_min'] or 'не указано'} мин · {MODES[i_['mode']]['label']}{flags}\n"
                f"- ориентир: {i_['landmark'] or '—'} · язык ответа: {i_['language']}")
            st.markdown("**2. Поиск по базе 2ГИС (код, без LLM)**")
            st.markdown(
                f"Радиус {fmt_dist(r['radius_m'])} от точки «{r['origin']['name']}», время {r['now'][11:16]}. "
                f"Отброшены закрытые и закрывающиеся до конца визита места, сезонные объекты вне сезона. "
                + ("Погода суровая — места на улице понижены в выдаче. " if w and w["harsh"] else "")
                + f"Кандидатов: **{len(r['candidates'])}**, уже показано: {len(r['shown'])}.")
            st.dataframe([{
                "место": c["name"], "категория": LABELS[c["main_category"]],
                "по прямой, м": c["distance_m"], "рейтинг": c["rating"],
                "сейчас": "под откр. небом" if c["outdoor"] else
                          {True: "открыто", None: "нет данных"}.get(c["open_now"], "закрыто"),
                "совпало": ", ".join(c["matched"]), "оценка": c["score"],
            } for c in r["candidates"]], hide_index=True, width="stretch")
            st.markdown(f"**3. Генерация (LLM `{r.get('model') or config.RAG_MODEL}`)** — выбирает места только "
                        f"из кандидатов; расстояния, часы и рейтинг подставляет код, а не модель.")
            st.markdown("**4. Маршруты (2ГИС Routing / Public Transport API)** — реальное время в пути "
                        "и линия маршрута на карте.")
            st.caption(f"Время этапов, с: {r['timings']}")
    else:
        st.info("Выберите пример сверху, нажмите «📍 Где я?» или напишите свой запрос.")

# ---------- Карта 2ГИС ----------
with right:
    origin = r["origin"] if r else ss.origin
    m = folium.Map(location=[origin["lat"], origin["lon"]], zoom_start=14, tiles=None)
    folium.TileLayer(tiles=TILES_2GIS, attr="© 2ГИС", subdomains="0123", max_zoom=18, name="2ГИС").add_to(m)
    folium.Marker([origin["lat"], origin["lon"]], tooltip=f"Старт: {origin['name']}",
                  icon=folium.Icon(color="red", icon="user", prefix="fa")).add_to(m)
    if r:
        bounds = [[origin["lat"], origin["lon"]]]
        shown = {it["id"] for it in r["items"]}
        for c in r["candidates"]:
            if c["id"] not in shown:
                folium.CircleMarker([c["lat"], c["lon"]], radius=4, color="#8c959f", fill=True,
                                    tooltip=c["name"]).add_to(m)
        for i, it in enumerate(r["items"], 1):
            color = LEG_COLORS[(i - 1) % len(LEG_COLORS)]
            geom = it["leg"]["geometry"]
            if len(geom) >= 2:
                folium.PolyLine(geom, color=color, weight=5, opacity=0.8,
                                dash_array=None if it["leg"]["real"] else "6",
                                tooltip=f"{it['name']}: {it['leg']['travel_min']} мин").add_to(m)
                bounds += geom
            folium.Marker([it["lat"], it["lon"]], tooltip=it["name"], icon=folium.DivIcon(html=(
                f'<div style="background:{color};color:#fff;border-radius:50%;width:26px;height:26px;'
                f'text-align:center;line-height:26px;font-weight:600;border:2px solid #fff;'
                f'box-shadow:0 1px 4px rgba(0,0,0,.4)">{i}</div>'))).add_to(m)
            bounds.append([it["lat"], it["lon"]])
        if len(bounds) > 1:
            m.fit_bounds(bounds, padding=(30, 30))
    out = st_folium(m, height=600, use_container_width=True, returned_objects=["last_clicked"], key="map")
    click = (out or {}).get("last_clicked")
    if click and click != ss.last_click:
        ss.last_click = click
        ss.origin = {"name": "точка на карте", "lat": round(click["lat"], 3), "lon": round(click["lng"], 3)}
        ss.result = None
        st.rerun()

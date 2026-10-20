"""Seruen — веб-сервер: API рекомендаций и квестов + фронтенд из web/.

Запуск:  python server.py   ->  http://localhost:8000
"""
import json
import uuid
from collections import OrderedDict
from datetime import datetime
from functools import lru_cache

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from seruen import admin, auth, business, config, social, vision, voice
from seruen.pulse import pulse_data
from seruen.categories import LABELS
from seruen.poi import ASTANA_TZ
from seruen.quest import build_quest
from seruen.recommend import MODES, NEEDS, _norm, distance_m, load_pois, more, recommend
from seruen.scenarios import SCENARIOS
from seruen.weather import PRESETS, describe, get_weather, hourly

WEB = config.ROOT / "web"
app = FastAPI(title="Seruen")
app.add_middleware(GZipMiddleware, minimum_size=2000)  # данные «Пульса» ~280 КБ -> ~60 КБ
app.mount("/static", StaticFiles(directory=WEB), name="static")

# Последние ответы — для «Показать другие» и озвучки. Только в памяти, без координат пользователя
# дольше сессии сервера; старые вытесняются.
_results: OrderedDict[str, dict] = OrderedDict()
MAX_RESULTS = 200


def _remember(result: dict) -> str:
    rid = uuid.uuid4().hex[:12]
    _results[rid] = result
    while len(_results) > MAX_RESULTS:
        _results.popitem(last=False)
    return rid


def _when(value: str | None) -> datetime:
    if not value:
        return datetime.now(ASTANA_TZ)
    return datetime.fromisoformat(value).replace(tzinfo=ASTANA_TZ)


def _weather(preset: str | None) -> dict | None:
    return describe(PRESETS[preset]) if preset in PRESETS else None


def _public(result: dict, rid: str) -> dict:
    return {"id": rid, **result}


class Ask(BaseModel):
    text: str
    lat: float
    lon: float
    place: str | None = None
    when: str | None = None       # ISO без пояса, время Астаны; пусто — сейчас
    weather: str | None = None    # пресет погоды для демо; пусто — прогноз
    mode: str | None = None
    budget: int | None = None
    group: int | None = None
    needs: list[str] = []


class QuestAsk(BaseModel):
    lat: float
    lon: float
    place: str | None = None
    when: str | None = None
    weather: str | None = None
    budget: int = 90


class More(BaseModel):
    id: str


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


@app.get("/api/meta")
def meta():
    m, _ = load_pois()
    return {
        "total": m["total"],
        "collected_at": m["collected_at"][:10],
        "landmarks": [{"name": k, "lat": v[0], "lon": v[1]} for k, v in config.LANDMARKS.items()],
        "examples": [{"title": s["chip"], "text": s["text"], "origin": s["origin"], "when": s["when"]}
                     for s in SCENARIOS],
        "weather_presets": list(PRESETS),
        "categories": LABELS,
        "needs": {k: v[0] for k, v in NEEDS.items()},
        "modes": {k: v["label"] for k, v in MODES.items()},
    }


@app.get("/api/weather")
def weather(lat: float, lon: float, when: str | None = None, preset: str | None = None):
    return _weather(preset) or get_weather(lat, lon, _when(when))


def _with_offers(result: dict) -> dict:
    """Предложения заведений — только в карточках мест, которые уже выбраны. На подбор не влияют."""
    when = datetime.fromisoformat(result["now"])
    offers = business.offers_for([it["id"] for it in result["items"]], when)
    for it in result["items"]:
        it["offer"] = offers.get(it["id"])
        if it["offer"]:
            business.hit(it["offer"]["id"], "view")
    return result


@app.post("/api/recommend")
def api_recommend(q: Ask):
    if not q.text.strip():
        raise HTTPException(400, "Пустой запрос")
    overrides = {"mode": q.mode if q.mode in MODES else None, "time_budget_min": q.budget,
                 "group_size": q.group if q.group and q.group > 1 else None,
                 "needs": [n for n in q.needs if n in NEEDS]}
    try:
        # Точка округляется до ~100 м: точнее для подбора мест не нужно.
        result = recommend(q.text, round(q.lat, 3), round(q.lon, 3), now=_when(q.when),
                           overrides=overrides, place=q.place, weather=_weather(q.weather))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return _public(_with_offers(result), _remember(result))


@app.post("/api/more")
def api_more(q: More):
    prev = _results.get(q.id)
    if not prev:
        raise HTTPException(404, "Подборка устарела — повторите запрос")
    try:
        result = more(prev)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return _public(_with_offers(result), _remember(result))


@app.post("/api/quest")
def api_quest(q: QuestAsk):
    try:
        return build_quest(round(q.lat, 3), round(q.lon, 3), _when(q.when), place=q.place,
                           budget_min=max(30, min(180, q.budget)), weather=_weather(q.weather))
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@app.post("/api/transcribe")
async def api_transcribe(audio: UploadFile = File(...)):
    data = await audio.read()
    try:
        # В пуле потоков: сетевой вызов не должен блокировать остальные запросы.
        return {"text": await run_in_threadpool(voice.transcribe, data, audio.filename or "query.webm")}
    except Exception as e:
        raise HTTPException(503, f"Не удалось распознать речь: {e}")


@app.post("/api/identify")
async def api_identify(image: UploadFile = File(...), lat: float = Form(...), lon: float = Form(...),
                       when: str | None = Form(None)):
    """«Что это за место?» по фото. Фото не сохраняется."""
    data = await image.read()
    if len(data) > 6_000_000:
        raise HTTPException(413, "Фото слишком большое")
    try:
        return await run_in_threadpool(vision.identify, data, image.content_type or "image/jpeg",
                                       round(lat, 3), round(lon, 3), _when(when))
    except Exception:
        raise HTTPException(503, "Не получилось распознать фото — попробуйте ещё раз через минуту")


@app.get("/api/pulse")
def api_pulse():
    return pulse_data()


@app.post("/api/speak")
def api_speak(q: More):
    result = _results.get(q.id)
    if not result or not voice.tts_available():
        raise HTTPException(404, "Озвучка недоступна")
    try:
        return Response(voice.speak(voice.answer_to_speech_text(result)), media_type="audio/mpeg")
    except RuntimeError as e:
        raise HTTPException(503, str(e))


# ---------- Лента ----------

@lru_cache(maxsize=1)
def _poi_index() -> dict[str, dict]:
    _, pois = load_pois()
    return {p["id"]: p for p in pois}


def _social(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except social.SocialError as e:
        raise HTTPException(400, str(e))


def _auth(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except auth.AuthError as e:
        raise HTTPException(e.status, str(e))


def _bearer(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    return h[7:] if h.lower().startswith("bearer ") else None


def optional_user(request: Request) -> dict | None:
    return _auth(auth.user_from_token, _bearer(request))


def current_user(request: Request) -> dict:
    user = optional_user(request)
    if not user:
        raise HTTPException(401, "Войдите в аккаунт")
    return user


class Register(BaseModel):
    name: str
    email: str
    password: str


class Login(BaseModel):
    email: str
    password: str


class Refresh(BaseModel):
    refresh_token: str


class NameChange(BaseModel):
    name: str


class Passport(BaseModel):
    passport: dict


class NewPost(BaseModel):
    place_id: str
    text: str


@app.post("/api/auth/register")
def api_register(r: Register, request: Request):
    return _auth(auth.register, r.name, r.email, r.password, request.client.host if request.client else "?")


@app.post("/api/auth/login")
def api_login(r: Login):
    return _auth(auth.login, r.email, r.password)


@app.post("/api/auth/refresh")
def api_refresh(r: Refresh):
    return _auth(auth.refresh, r.refresh_token)


@app.post("/api/auth/logout")
def api_logout(request: Request):
    token = _bearer(request)
    if token:
        try:
            auth.logout(token)
        except auth.AuthError:
            pass  # выйти локально можно и без ответа сервера
    return {"ok": True}


@app.get("/api/me")
def api_me(user: dict = Depends(current_user)):
    prof = _social(social.get_profile, user["id"]) or {}
    posts = _social(social.my_posts, user["id"])
    return {
        "id": user["id"], "email": user["email"], "name": prof.get("name"), "created_at": prof.get("created_at"),
        "is_admin": business.is_admin(user),
        "passport": prof.get("passport") or None, "passport_sync": social.passport_sync_enabled(),
        "stats": {"posts": sum(1 for p in posts if not p["hidden"]),
                  "likes": sum(p["likes_count"] for p in posts)},
        "posts": posts,
    }


@app.patch("/api/me")
def api_rename(r: NameChange, user: dict = Depends(current_user)):
    return _social(social.upsert_profile, user["id"], r.name)


@app.put("/api/me/passport")
def api_passport(r: Passport, user: dict = Depends(current_user)):
    if len(json.dumps(r.passport)) > 60_000:
        raise HTTPException(413, "Паспорт слишком большой")
    return {"saved": _social(social.save_passport, user["id"], r.passport)}


@app.get("/api/social/status")
def social_status():
    return social.status()


@app.get("/api/feed")
def api_feed(sort: str = "new", lat: float | None = None, lon: float | None = None,
             user: dict | None = Depends(optional_user)):
    me = user["id"] if user else None
    return _social(social.feed, sort if sort in ("new", "top", "near") else "new", me, lat, lon)


@app.post("/api/posts")
def api_post(p: NewPost, user: dict = Depends(current_user)):
    place = _poi_index().get(p.place_id)
    if not place:
        raise HTTPException(400, "Такого места нет в каталоге")
    return _social(social.create_post, user["id"], place, p.text)


@app.post("/api/posts/{post_id}/like")
def api_like(post_id: int, user: dict = Depends(current_user)):
    return _social(social.toggle_like, post_id, user["id"])


@app.post("/api/posts/{post_id}/report")
def api_report(post_id: int, user: dict = Depends(current_user)):
    _social(social.report, post_id, user["id"])
    return {"ok": True}


@app.delete("/api/posts/{post_id}")
def api_delete(post_id: int, user: dict = Depends(current_user)):
    _social(social.delete_post, post_id, user["id"])
    return {"ok": True}


@app.get("/api/places")
def api_places(q: str, lat: float | None = None, lon: float | None = None):
    """Поиск места из каталога по названию — для «Поделиться местом»."""
    needle = _norm(q)
    if len(needle) < 2:
        return []
    _, pois = load_pois()
    hits = [p for p in pois if needle in _norm(p["name"])]
    hits.sort(key=lambda p: (not _norm(p["name"]).startswith(needle), -p["reviews"]))
    out = []
    for p in hits[:8]:
        item = {"id": p["id"], "name": p["name"], "category": p["categories"][0], "address": p["address"]}
        if lat is not None and lon is not None:
            item["distance_m"] = round(distance_m(lat, lon, p["lat"], p["lon"]))
        out.append(item)
    return out


# ---------- Фото: «Как на фото» и фото-отметка в квесте ----------

@app.post("/api/vibe")
async def api_vibe(image: UploadFile = File(...), lat: float = Form(...), lon: float = Form(...),
                   place: str | None = Form(None), when: str | None = Form(None), weather: str | None = Form(None)):
    """Картинка с атмосферой -> текстовый запрос -> обычный подбор мест. Фото не сохраняется."""
    data = await image.read()
    if len(data) > 6_000_000:
        raise HTTPException(413, "Фото слишком большое")
    try:
        vibe = await run_in_threadpool(vision.describe_vibe, data, image.content_type or "image/jpeg")
    except Exception:
        raise HTTPException(503, "Не получилось разобрать картинку — попробуйте другую или через минуту")
    try:
        result = await run_in_threadpool(lambda: recommend(vibe["query"], round(lat, 3), round(lon, 3), now=_when(when),
                                                           place=place, weather=_weather(weather)))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    result["vibe"] = vibe
    return _public(_with_offers(result), _remember(result))


@app.post("/api/quest/verify")
async def api_quest_verify(image: UploadFile = File(...), place_id: str = Form(...)):
    """Фото-отметка: модель проверяет, что на снимке действительно эта точка квеста."""
    place = _poi_index().get(place_id)
    if not place:
        raise HTTPException(400, "Такого места нет в каталоге")
    data = await image.read()
    if len(data) > 6_000_000:
        raise HTTPException(413, "Фото слишком большое")
    try:
        return await run_in_threadpool(vision.verify_checkin, data, image.content_type or "image/jpeg", place, _when(None))
    except Exception:
        raise HTTPException(503, "Не получилось проверить фото — попробуйте ещё раз через минуту")


@app.get("/api/weather/hourly")
def api_weather_hourly(lat: float = config.DEFAULT_LAT, lon: float = config.DEFAULT_LON):
    return hourly(lat, lon)


# ---------- Seruen для бизнеса ----------

class Apply(BaseModel):
    place_id: str
    contact: str


class OfferIn(BaseModel):
    kind: str
    title: str
    details: str | None = None
    days: list[int] = [0, 1, 2, 3, 4, 5, 6]
    start_min: int = 0
    end_min: int = 1440
    valid_until: str | None = None


class OfferPatch(BaseModel):
    active: bool


class StatusIn(BaseModel):
    status: str


def _owner_business(user: dict) -> dict:
    b = _social(business.my_business, user["id"])
    if not b:
        raise HTTPException(404, "Сначала подключите заведение")
    if b["status"] != "approved":
        raise HTTPException(403, "Заявка ещё на проверке")
    return b


@app.get("/api/business/me")
def api_business_me(user: dict = Depends(current_user)):
    b = _social(business.my_business, user["id"])
    out = {"business": b, "is_admin": business.is_admin(user), "admin_configured": bool(business.ADMIN_EMAILS)}
    if b and b["status"] == "approved":
        out["offers"] = _social(business.list_offers, b["id"])
        out["stats"] = _social(business.stats, b["id"])
    return out


@app.post("/api/business/apply")
def api_business_apply(a: Apply, user: dict = Depends(current_user)):
    place = _poi_index().get(a.place_id)
    if not place:
        raise HTTPException(400, "Такого места нет в каталоге")
    return _social(business.apply, user["id"], place, a.contact)


@app.post("/api/business/offers")
def api_offer_create(o: OfferIn, user: dict = Depends(current_user)):
    return _social(business.create_offer, _owner_business(user), o.model_dump())


@app.patch("/api/business/offers/{offer_id}")
def api_offer_patch(offer_id: int, o: OfferPatch, user: dict = Depends(current_user)):
    _social(business.set_offer_active, _owner_business(user), offer_id, o.active)
    return {"ok": True}


@app.delete("/api/business/offers/{offer_id}")
def api_offer_delete(offer_id: int, user: dict = Depends(current_user)):
    _social(business.delete_offer, _owner_business(user), offer_id)
    return {"ok": True}


@app.post("/api/business/key")
def api_business_key(user: dict = Depends(current_user)):
    return {"api_key": _social(business.issue_api_key, user["id"])}


# ---------- Панель администратора ----------

def admin_user(request: Request) -> dict:
    user = current_user(request)
    if not business.is_admin(user):
        raise HTTPException(403, "Только для администратора Seruen")
    return user


class Hidden(BaseModel):
    hidden: bool


@app.get("/api/admin/overview")
def api_admin_overview(_: dict = Depends(admin_user)):
    return _social(admin.overview)


@app.get("/api/admin/health")
def api_admin_health(_: dict = Depends(admin_user)):
    return admin.health()


@app.get("/api/admin/businesses")
def api_admin_list(_: dict = Depends(admin_user)):
    return _social(business.list_applications)


@app.post("/api/admin/businesses/{business_id}")
def api_admin_status(business_id: str, st: StatusIn, _: dict = Depends(admin_user)):
    _social(business.set_status, business_id, st.status)
    return {"ok": True}


@app.get("/api/admin/posts")
def api_admin_posts(kind: str = "reported", _: dict = Depends(admin_user)):
    return _social(admin.posts, kind if kind in ("reported", "hidden", "all") else "reported")


@app.post("/api/admin/posts/{post_id}")
def api_admin_post_hidden(post_id: int, h: Hidden, _: dict = Depends(admin_user)):
    _social(admin.set_post_hidden, post_id, h.hidden)
    return {"ok": True}


@app.delete("/api/admin/posts/{post_id}")
def api_admin_post_delete(post_id: int, _: dict = Depends(admin_user)):
    _social(admin.delete_post, post_id)
    return {"ok": True}


@app.get("/api/admin/offers")
def api_admin_offers(_: dict = Depends(admin_user)):
    return _social(admin.offers)


@app.post("/api/admin/offers/{offer_id}")
def api_admin_offer(offer_id: int, o: OfferPatch, _: dict = Depends(admin_user)):
    _social(admin.set_offer_active, offer_id, o.active)
    return {"ok": True}


@app.get("/api/admin/users")
def api_admin_users(_: dict = Depends(admin_user)):
    return _social(admin.users)


@app.get("/api/offers/active")
def api_offers_active():
    """Для слоя «Предложения» в «Пульсе»: где и когда действуют предложения."""
    idx = _poi_index()
    out = []
    for o in business.active_offers():
        p = idx.get(o["place_id"])
        if p:
            out.append({**business.public_offer(o), "place_name": p["name"], "lat": p["lat"], "lon": p["lon"]})
    return out


@app.post("/api/offers/{offer_id}/click")
def api_offer_click(offer_id: int):
    business.hit(offer_id, "click")
    return {"ok": True}


# ---------- Публичное API для интеграции (касса, CRM, сайт заведения) ----------

def api_key_business(request: Request) -> dict:
    b = _social(business.business_by_key, request.headers.get("x-api-key"))
    if not b:
        raise HTTPException(401, "Неверный или отозванный ключ API")
    return b


@app.get("/api/v1/offers")
def v1_offers(b: dict = Depends(api_key_business)):
    return _social(business.list_offers, b["id"])


@app.post("/api/v1/offers")
def v1_offer_create(o: OfferIn, b: dict = Depends(api_key_business)):
    return _social(business.create_offer, b, o.model_dump())


@app.patch("/api/v1/offers/{offer_id}")
def v1_offer_patch(offer_id: int, o: OfferPatch, b: dict = Depends(api_key_business)):
    _social(business.set_offer_active, b, offer_id, o.active)
    return {"ok": True}


@app.delete("/api/v1/offers/{offer_id}")
def v1_offer_delete(offer_id: int, b: dict = Depends(api_key_business)):
    _social(business.delete_offer, b, offer_id)
    return {"ok": True}


@app.get("/api/v1/stats")
def v1_stats(b: dict = Depends(api_key_business)):
    return _social(business.stats, b["id"])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)

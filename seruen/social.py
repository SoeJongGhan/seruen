"""Лента: люди делятся местами и ставят лайки.

Хранилище — Supabase (PostgREST). Ходит туда только сервер Seruen с секретным ключом:
браузер ключа не видит, поэтому модерацию и лимиты нельзя обойти напрямую.
Место для поста берётся из нашей базы 2ГИС по id — подделать название или координаты нельзя.
"""
import json
import math
import os
import re
import threading
import time
import uuid

import requests

from . import config  # загружает .env до чтения ключей ниже

URL = os.getenv("SUPABASE_URL", "").rstrip("/")
# Нужен серверный ключ (service_role / sb_secret_...): таблицы закрыты RLS от публичного ключа.
KEY = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_KEY", "")
MODERATION_MODEL = os.getenv("MODERATION_MODEL", "openai/gpt-oss-safeguard-20b")
# Связь указана явно: посты и профили связаны ещё через лайки и жалобы, и без подсказки
# PostgREST не знает, какую взять (PGRST201).
POST_SELECT = ("id,place_id,place_name,place_category,lat,lon,text,likes_count,created_at,"
               "author:seruen_profiles!seruen_posts_author_id_fkey(id,name)")

_session = requests.Session()
_lock = threading.Lock()
_recent_posts: dict[str, list[float]] = {}
_stats_cache: tuple[float, dict] = (0.0, {})


class SocialError(RuntimeError):
    """Понятное пользователю сообщение об ошибке ленты."""


class Duplicate(SocialError):
    """Такая запись уже есть (повторный лайк или жалоба)."""


class MissingColumn(SocialError):
    """В таблице нет колонки — не применена миграция."""


def configured() -> bool:
    return bool(URL and KEY)


def _req(method: str, table: str, *, params=None, body=None, prefer: str | None = None,
         timeout: tuple = (4, 10), retry: bool = True):
    """Запрос к Supabase. Для необязательных данных (счётчики, предложения) передают короткий
    timeout и retry=False — чтобы медленная база не тормозила подбор мест."""
    if not configured():
        raise SocialError("Лента не подключена: задайте SUPABASE_URL и SUPABASE_SERVICE_KEY в .env")
    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    # Чтение повторяем один раз: сеть бывает нестабильной. Запись не повторяем — можно создать дубль.
    tries = 2 if method == "GET" and retry else 1
    for attempt in range(tries):
        try:
            r = _session.request(method, f"{URL}/rest/v1/{table}", params=params, json=body,
                                 headers=headers, timeout=timeout)
            break
        except requests.RequestException:
            if attempt == tries - 1:
                raise SocialError("Лента сейчас недоступна — нет связи с базой") from None
    if r.status_code >= 300:  # 300 — неоднозначный запрос (PGRST201), это тоже ошибка
        try:
            err = r.json()
        except ValueError:
            err = {}
        code, msg = str(err.get("code", "")), str(err.get("message", ""))
        if code == "42703" or (code == "PGRST204" and "column" in msg):
            raise MissingColumn(msg)
        if code in ("PGRST205", "42P01") or "schema cache" in msg or "does not exist" in msg:
            raise SocialError("Нужные таблицы в базе ещё не созданы — выполните миграции из папки db/ в Supabase")
        if code == "42501" or r.status_code in (401, 403):
            raise SocialError("Нет доступа к таблицам ленты — нужен серверный ключ (service_role) в SUPABASE_SERVICE_KEY")
        if code == "23505":
            raise Duplicate("Уже есть")
        raise SocialError(f"База ответила {r.status_code}: {msg[:160]}")
    return r.json() if r.content else None


def status() -> dict:
    """Подключена ли лента — для экрана ленты и отладки."""
    try:
        _req("GET", "seruen_posts", params={"select": "id", "limit": 1})
        return {"ok": True}
    except SocialError as e:
        return {"ok": False, "error": str(e)}


# ---------- Модерация ----------

_PHONE = re.compile(r"(?:\+?7|8)[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
_LINK = re.compile(r"https?://|www\.|\b[\w-]+\.(?:kz|ru|com|net|org|io)\b", re.IGNORECASE)

MODERATION_POLICY = """Ты модератор отзывов о местах города в приложении Seruen.
Нарушение (violation = 1), если текст содержит хотя бы одно:
- оскорбления, травлю или унижение людей (включая персонал);
- ненависть или дискриминацию по национальности, религии, полу, возрасту, инвалидности;
- угрозы, призывы к насилию или незаконным действиям;
- сексуальный контент;
- рекламу, спам, промокоды, бессмысленный набор символов;
- личные данные частных лиц (адреса, телефоны, обвинения конкретных людей по имени).
НЕ нарушение: критика заведения, сервиса, цен, еды; эмоциональные, но не оскорбительные оценки; мат-заглушки.
Ответь только JSON: {"violation": 0 или 1, "reason": "если 1 — коротко по-русски, почему"}"""


OFFER_POLICY = """Ты модератор предложений заведений (скидки, события, новинки) в приложении Seruen.
Реклама и акции заведения — это нормально, за это не наказывай.
Нарушение (violation = 1), если текст содержит хотя бы одно:
- оскорбления, дискриминацию или унижение людей;
- сексуальный контент, призывы к насилию или незаконным действиям;
- призывы к чрезмерному употреблению алкоголя или табака, акции на алкоголь для несовершеннолетних;
- заведомый обман («всё бесплатно навсегда», гарантированный выигрыш);
- содержание не про заведение: спам, криптовалюта, ставки и азартные игры, финансовые пирамиды.
Ответь только JSON: {"violation": 0 или 1, "reason": "если 1 — коротко по-русски, почему"}"""


def moderate(text: str, policy: str = MODERATION_POLICY) -> str | None:
    """None — можно публиковать, иначе причина отказа для пользователя.
    policy — правила: для отзывов (по умолчанию) или для предложений заведений (OFFER_POLICY)."""
    if _PHONE.search(text) or _EMAIL.search(text):
        return "Без телефонов и почты — это личные данные."
    if _LINK.search(text):
        return "Ссылки в отзывах не публикуем."
    from .recommend import _client  # ленивый импорт: recommend сам импортирует social
    verdict = None
    # У safeguard-модели на бесплатном Groq лимит 2000 токенов в минуту — при упоре в него
    # проверяем той же политикой на gpt-oss-20b. max_completion_tokens обязателен: без него Groq
    # резервирует ~8000 токенов на ответ и отклоняет запрос целиком.
    for model in (MODERATION_MODEL, config.INTENT_MODEL):
        try:
            resp = _client().with_options(max_retries=0).chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": policy}, {"role": "user", "content": text}],
                response_format={"type": "json_object"}, reasoning_effort="low", temperature=0,
                max_completion_tokens=400,
            )
            verdict = json.loads(resp.choices[0].message.content)
            break
        except Exception:
            continue
    if verdict is None:
        return None  # обе модели недоступны — регулярки выше отработали, остальное скроют жалобы
    if int(verdict.get("violation") or 0) == 1:
        return f"Не получилось опубликовать: {verdict.get('reason') or 'текст не прошёл проверку'}."
    return None


# ---------- Профили, посты, лайки ----------

def _uuid(value: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        raise SocialError("Некорректный профиль") from None


def upsert_profile(profile_id: str, name: str) -> dict:
    name = re.sub(r"\s+", " ", (name or "").strip())
    if not 2 <= len(name) <= 24:
        raise SocialError("Имя — от 2 до 24 символов")
    if _LINK.search(name) or _PHONE.search(name) or _EMAIL.search(name):
        raise SocialError("В имени не должно быть ссылок и контактов")
    rows = _req("POST", "seruen_profiles", body={"id": _uuid(profile_id), "name": name},
                params={"on_conflict": "id"}, prefer="resolution=merge-duplicates,return=representation")
    return rows[0]


# Есть ли колонка passport (миграция db/002_auth.sql). None — ещё не проверяли.
_has_passport: bool | None = None


def get_profile(user_id: str) -> dict | None:
    global _has_passport
    cols = "id,name,created_at" + (",passport" if _has_passport is not False else "")
    try:
        rows = _req("GET", "seruen_profiles", params={"select": cols, "id": f"eq.{_uuid(user_id)}"})
    except MissingColumn:
        _has_passport = False
        return get_profile(user_id)
    _has_passport = _has_passport if _has_passport is not None else True
    return rows[0] if rows else None


def passport_sync_enabled() -> bool:
    return _has_passport is not False


def save_passport(user_id: str, passport: dict) -> bool:
    if _has_passport is False:
        return False
    try:
        _req("PATCH", "seruen_profiles", params={"id": f"eq.{_uuid(user_id)}"}, body={"passport": passport},
             prefer="return=minimal")
    except MissingColumn:
        return False
    return True


def my_posts(user_id: str) -> list[dict]:
    return _req("GET", "seruen_posts", params={"select": POST_SELECT + ",hidden", "author_id": f"eq.{_uuid(user_id)}",
                                                "order": "created_at.desc", "limit": 100}) or []


def _distance(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


def feed(sort: str = "new", me: str | None = None, lat: float | None = None, lon: float | None = None,
         limit: int = 40) -> list[dict]:
    params = {"select": POST_SELECT, "hidden": "eq.false"}
    if sort == "top":
        params.update(order="likes_count.desc,created_at.desc", limit=limit)
    else:
        params.update(order="created_at.desc", limit=200 if sort == "near" else limit)
    posts = _req("GET", "seruen_posts", params=params) or []
    for p in posts:
        if lat is not None and lon is not None:
            p["distance_m"] = round(_distance(lat, lon, p["lat"], p["lon"]))
    if sort == "near" and lat is not None:
        posts = sorted(posts, key=lambda p: p["distance_m"])[:limit]
    liked = set()
    if me and posts:
        ids = ",".join(str(p["id"]) for p in posts)
        rows = _req("GET", "seruen_likes", params={"select": "post_id", "profile_id": f"eq.{_uuid(me)}",
                                                    "post_id": f"in.({ids})"}) or []
        liked = {r["post_id"] for r in rows}
    demo = demo_ids()
    for p in posts:
        p["liked"] = p["id"] in liked
        p["mine"] = bool(me) and (p.get("author") or {}).get("id") == me
        if p.get("author"):
            p["author"]["demo"] = p["author"]["id"] in demo
    return posts


def demo_ids() -> set[str]:
    """Демо-аккаунты (python -m seruen.demo_seed) — в ленте их посты помечаются плашкой «демо»."""
    path = config.DATA_DIR / "demo_accounts.json"
    if not path.exists():
        return set()
    try:
        return {a["id"] for a in json.loads(path.read_text("utf-8")).get("accounts", [])}
    except (ValueError, KeyError):
        return set()


def create_post(author_id: str, place: dict, text: str) -> dict:
    author_id = _uuid(author_id)
    text = re.sub(r"[ \t]+", " ", (text or "").strip())
    if not 3 <= len(text) <= 280:
        raise SocialError("Отзыв — от 3 до 280 символов")
    with _lock:  # не больше 5 постов за 10 минут с одного профиля
        now = time.time()
        recent = [t for t in _recent_posts.get(author_id, []) if now - t < 600]
        if len(recent) >= 5:
            raise SocialError("Слишком часто. Попробуйте через несколько минут.")
    reason = moderate(text)
    if reason:
        raise SocialError(reason)
    rows = _req("POST", "seruen_posts", prefer="return=representation", body={
        "author_id": author_id, "place_id": place["id"], "place_name": place["name"],
        "place_category": place["categories"][0] if place["categories"] else None,
        "lat": place["lat"], "lon": place["lon"], "text": text,
    })
    with _lock:
        _recent_posts.setdefault(author_id, []).append(time.time())
    _invalidate_stats()
    return rows[0]


def toggle_like(post_id: int, profile_id: str) -> dict:
    profile_id = _uuid(profile_id)
    try:
        _req("POST", "seruen_likes", body={"post_id": post_id, "profile_id": profile_id}, prefer="return=minimal")
        liked = True
    except Duplicate:
        _req("DELETE", "seruen_likes", params={"post_id": f"eq.{post_id}", "profile_id": f"eq.{profile_id}"})
        liked = False
    row = (_req("GET", "seruen_posts", params={"select": "likes_count", "id": f"eq.{post_id}"}) or [{}])[0]
    _invalidate_stats()
    return {"liked": liked, "likes": row.get("likes_count", 0)}


def report(post_id: int, profile_id: str) -> None:
    profile_id = _uuid(profile_id)
    try:
        _req("POST", "seruen_reports", body={"post_id": post_id, "profile_id": profile_id}, prefer="return=minimal")
    except Duplicate:
        pass  # уже жаловался — второй раз не считаем
    _invalidate_stats()


def delete_post(post_id: int, profile_id: str) -> None:
    _req("DELETE", "seruen_posts", params={"id": f"eq.{post_id}", "author_id": f"eq.{_uuid(profile_id)}"})
    _invalidate_stats()


# ---------- Связь с рекомендациями ----------

def _invalidate_stats() -> None:
    global _stats_cache
    _stats_cache = (0.0, {})


def place_stats(ttl: float = 60) -> dict[str, dict]:
    """{place_id: {"posts": n, "likes": m}} — сколько людей советуют место. Пусто, если лента
    не подключена: рекомендации от этого не ломаются."""
    global _stats_cache
    ts, cached = _stats_cache
    if time.time() - ts < ttl:
        return cached
    stats: dict[str, dict] = {}
    try:
        rows = _req("GET", "seruen_posts", params={"select": "place_id,likes_count", "hidden": "eq.false",
                                                     "limit": 2000}, timeout=(2, 3), retry=False) or []
        for r in rows:
            s = stats.setdefault(r["place_id"], {"posts": 0, "likes": 0})
            s["posts"] += 1
            s["likes"] += r["likes_count"]
    except SocialError:
        stats = {}
    _stats_cache = (time.time(), stats)
    return stats

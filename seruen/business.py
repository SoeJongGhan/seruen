"""Seruen для бизнеса: заведения публикуют предложения (скидки, события, новинки).

Правило честности: предложения НЕ влияют на подбор и порядок мест. Они показываются только в
карточке места, которое и так подошло человеку, и помечены как реклама.

Подключение: заявка владельца -> проверка командой Seruen (ADMIN_EMAILS в .env) -> кабинет.
Интеграция с кассой или CRM — REST API по ключу (X-Api-Key), ключ хранится только как хеш.
"""
import hashlib
import os
import re
import secrets
import time
from datetime import date, datetime

from . import config  # загружает .env до чтения переменных ниже
from .poi import ASTANA_TZ
from .social import OFFER_POLICY, SocialError, _req, _uuid, moderate

ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}
KINDS = {"discount": "Скидка", "event": "Событие", "news": "Новинка"}
OFFER_COLS = "id,business_id,place_id,kind,title,details,days,start_min,end_min,valid_until,active,created_at"
_active_cache: tuple[float, list] = (0.0, [])


def is_admin(user: dict | None) -> bool:
    """Админ — роль admin в Supabase (python -m seruen.make_admin) или email из ADMIN_EMAILS."""
    return bool(user and (user.get("role") == "admin" or (user.get("email") or "").lower() in ADMIN_EMAILS))


# ---------- Заведения ----------

def my_business(owner_id: str) -> dict | None:
    rows = _req("GET", "seruen_businesses", params={
        "select": "id,place_id,place_name,contact,status,created_at,api_key_hash", "owner_id": f"eq.{_uuid(owner_id)}"})
    if not rows:
        return None
    b = rows[0]
    b["has_api_key"] = bool(b.pop("api_key_hash"))
    return b


def apply(owner_id: str, place: dict, contact: str) -> dict:
    contact = (contact or "").strip()
    if not 5 <= len(contact) <= 120:
        raise SocialError("Укажите телефон или email для связи — по ним мы подтвердим, что вы представляете заведение")
    if my_business(owner_id):
        raise SocialError("У вас уже есть подключённое заведение")
    taken = _req("GET", "seruen_businesses", params={"select": "id", "place_id": f"eq.{place['id']}"})
    if taken:
        raise SocialError("Это заведение уже подключено другим владельцем. Напишите нам, если это ошибка.")
    rows = _req("POST", "seruen_businesses", prefer="return=representation", body={
        "owner_id": _uuid(owner_id), "place_id": place["id"], "place_name": place["name"], "contact": contact})
    return rows[0]


def list_applications() -> list[dict]:
    return _req("GET", "seruen_businesses", params={
        "select": "id,place_id,place_name,contact,status,created_at,owner:seruen_profiles(name)",
        "order": "created_at.desc", "limit": 100}) or []


def set_status(business_id: str, status: str) -> None:
    if status not in ("approved", "rejected", "pending"):
        raise SocialError("Неизвестный статус")
    _req("PATCH", "seruen_businesses", params={"id": f"eq.{_uuid(business_id)}"}, body={"status": status},
         prefer="return=minimal")
    _invalidate()


def _approved(owner_id: str) -> dict:
    b = my_business(owner_id)
    if not b:
        raise SocialError("Сначала подключите заведение")
    if b["status"] != "approved":
        raise SocialError("Заявка ещё на проверке — публиковать предложения можно после одобрения")
    return b


# ---------- Ключ интеграции ----------

def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def issue_api_key(owner_id: str) -> str:
    b = _approved(owner_id)
    key = "srn_" + secrets.token_urlsafe(24)
    _req("PATCH", "seruen_businesses", params={"id": f"eq.{b['id']}"}, body={"api_key_hash": _hash(key)},
         prefer="return=minimal")
    return key  # показываем один раз: в базе остаётся только хеш


def business_by_key(key: str | None) -> dict | None:
    if not key or not key.startswith("srn_"):
        return None
    rows = _req("GET", "seruen_businesses", params={
        "select": "id,owner_id,place_id,place_name,status", "api_key_hash": f"eq.{_hash(key)}"})
    return rows[0] if rows and rows[0]["status"] == "approved" else None


# ---------- Предложения ----------

def _clean_offer(data: dict) -> dict:
    kind = data.get("kind")
    if kind not in KINDS:
        raise SocialError("Тип предложения: discount, event или news")
    title = re.sub(r"\s+", " ", str(data.get("title") or "")).strip()
    details = re.sub(r"[ \t]+", " ", str(data.get("details") or "")).strip() or None
    if not 3 <= len(title) <= 80:
        raise SocialError("Заголовок — от 3 до 80 символов")
    if details and len(details) > 300:
        raise SocialError("Описание — до 300 символов")
    days = sorted({int(d) for d in (data.get("days") or range(7)) if 0 <= int(d) <= 6})
    if not days:
        raise SocialError("Выберите хотя бы один день")
    start, end = int(data.get("start_min", 0)), int(data.get("end_min", 1440))
    if not (0 <= start <= 1440 and 0 <= end <= 1440) or start == end:
        raise SocialError("Проверьте часы действия")
    valid_until = data.get("valid_until") or None
    if valid_until:
        try:
            if date.fromisoformat(str(valid_until)) < datetime.now(ASTANA_TZ).date():
                raise SocialError("Дата окончания уже прошла")
        except ValueError:
            raise SocialError("Дата окончания в формате ГГГГ-ММ-ДД") from None
    reason = moderate(f"{title}. {details or ''}", policy=OFFER_POLICY)  # реклама разрешена, обман и спам — нет
    if reason:
        raise SocialError(reason)
    return {"kind": kind, "title": title, "details": details, "days": days,
            "start_min": start, "end_min": end, "valid_until": valid_until}


def create_offer(business: dict, data: dict) -> dict:
    rows = _req("POST", "seruen_offers", prefer="return=representation",
                body={"business_id": business["id"], "place_id": business["place_id"], **_clean_offer(data)})
    _invalidate()
    return rows[0]


def list_offers(business_id: str) -> list[dict]:
    return _req("GET", "seruen_offers", params={"select": OFFER_COLS, "business_id": f"eq.{business_id}",
                                                 "order": "created_at.desc"}) or []


def set_offer_active(business: dict, offer_id: int, active: bool) -> None:
    _req("PATCH", "seruen_offers", params={"id": f"eq.{int(offer_id)}", "business_id": f"eq.{business['id']}"},
         body={"active": bool(active)}, prefer="return=minimal")
    _invalidate()


def delete_offer(business: dict, offer_id: int) -> None:
    _req("DELETE", "seruen_offers", params={"id": f"eq.{int(offer_id)}", "business_id": f"eq.{business['id']}"})
    _invalidate()


def stats(business_id: str) -> dict:
    offers = list_offers(business_id)
    if not offers:
        return {"views": 0, "clicks": 0, "by_offer": {}}
    ids = ",".join(str(o["id"]) for o in offers)
    rows = _req("GET", "seruen_offer_stats", params={"select": "offer_id,views,clicks", "offer_id": f"in.({ids})"}) or []
    by_offer: dict[int, dict] = {}
    for r in rows:
        s = by_offer.setdefault(r["offer_id"], {"views": 0, "clicks": 0})
        s["views"] += r["views"]
        s["clicks"] += r["clicks"]
    return {"views": sum(s["views"] for s in by_offer.values()),
            "clicks": sum(s["clicks"] for s in by_offer.values()), "by_offer": by_offer}


def hit(offer_id: int, kind: str) -> None:
    if kind in ("view", "click"):
        try:
            _req("POST", "rpc/seruen_offer_hit", body={"p_offer": int(offer_id), "p_kind": kind}, timeout=(2, 3))
        except SocialError:
            pass  # статистика не должна ломать показ рекомендаций


# ---------- Что показывать сейчас ----------

def _invalidate() -> None:
    global _active_cache
    _active_cache = (0.0, [])


def active_offers() -> list[dict]:
    """Включённые предложения одобренных заведений, срок которых не истёк (кеш 30 секунд).
    Пусто, если таблиц ещё нет: рекомендации от этого не ломаются."""
    global _active_cache
    ts, cached = _active_cache
    if time.time() - ts < 30:
        return cached
    try:
        rows = _req("GET", "seruen_offers", params={
            "select": OFFER_COLS + ",business:seruen_businesses!inner(status,place_name)",
            "active": "eq.true", "business.status": "eq.approved", "limit": 500}, timeout=(2, 3), retry=False) or []
        today = datetime.now(ASTANA_TZ).date().isoformat()
        rows = [r for r in rows if not r["valid_until"] or r["valid_until"] >= today]
    except SocialError:
        rows = []
    _active_cache = (time.time(), rows)
    return rows


def runs_at(offer: dict, when: datetime) -> bool:
    """Действует ли предложение в момент when (время Астаны). Окно может переходить через полночь."""
    t = when.astimezone(ASTANA_TZ)
    day, minute = t.weekday(), t.hour * 60 + t.minute
    s, e = offer["start_min"], offer["end_min"]
    if s < e:
        return day in offer["days"] and s <= minute < e
    # Ночное окно, например 22:00–02:00: вечер этого дня или утро после дня из списка.
    return (day in offer["days"] and minute >= s) or (((day - 1) % 7) in offer["days"] and minute < e)


def offers_for(place_ids: list[str], when: datetime) -> dict[str, dict]:
    """Одно действующее предложение на место — для карточек рекомендаций."""
    wanted = set(place_ids)
    out: dict[str, dict] = {}
    for o in active_offers():
        if o["place_id"] in wanted and o["place_id"] not in out and runs_at(o, when):
            out[o["place_id"]] = public_offer(o)
    return out


def public_offer(o: dict) -> dict:
    return {"id": o["id"], "kind": o["kind"], "kind_label": KINDS[o["kind"]], "title": o["title"],
            "details": o["details"], "days": o["days"], "start_min": o["start_min"], "end_min": o["end_min"],
            "valid_until": o["valid_until"], "place_id": o["place_id"]}

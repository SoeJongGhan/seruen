"""Панель администратора: сводка, модерация ленты, предложения, пользователи, состояние системы.
Все функции вызываются только после проверки роли на сервере (business.is_admin)."""
import os
from concurrent.futures import ThreadPoolExecutor

from . import auth, config, social
from .recommend import load_pois
from .social import _req

POST_COLS = social.POST_SELECT + ",hidden,reports_count"


def _ids(table: str, **filters) -> list[dict]:
    return _req("GET", table, params={"select": "id", "limit": 10000, **filters}) or []


def overview() -> dict:
    # Четыре независимых запроса — параллельно: база бывает медленной.
    with ThreadPoolExecutor(max_workers=4) as pool:
        f_posts = pool.submit(_req, "GET", "seruen_posts", params={"select": "id,hidden,reports_count", "limit": 10000})
        f_biz = pool.submit(_req, "GET", "seruen_businesses", params={"select": "id,status", "limit": 10000})
        f_offers = pool.submit(_req, "GET", "seruen_offers", params={"select": "id,active", "limit": 10000})
        f_users = pool.submit(_ids, "seruen_profiles")
        posts, businesses, offers = f_posts.result() or [], f_biz.result() or [], f_offers.result() or []
        users = f_users.result()
    return {
        "users": len(users),
        "posts": len(posts),
        "hidden": sum(1 for p in posts if p["hidden"]),
        "reported": sum(1 for p in posts if p["reports_count"] > 0 and not p["hidden"]),
        "businesses": len(businesses),
        "pending": sum(1 for b in businesses if b["status"] == "pending"),
        "offers_active": sum(1 for o in offers if o["active"]),
    }


def posts(kind: str = "reported") -> list[dict]:
    params = {"select": POST_COLS, "order": "reports_count.desc,created_at.desc", "limit": 200}
    if kind == "reported":
        params["reports_count"] = "gt.0"
    elif kind == "hidden":
        params["hidden"] = "eq.true"
    rows = _req("GET", "seruen_posts", params=params) or []
    demo = social.demo_ids()
    for r in rows:
        if r.get("author"):
            r["author"]["demo"] = r["author"]["id"] in demo
    return rows


def set_post_hidden(post_id: int, hidden: bool) -> None:
    body = {"hidden": bool(hidden)}
    if not hidden:
        body["reports_count"] = 0  # вернули после проверки — жалобы считаем закрытыми
        _req("DELETE", "seruen_reports", params={"post_id": f"eq.{int(post_id)}"})
    _req("PATCH", "seruen_posts", params={"id": f"eq.{int(post_id)}"}, body=body, prefer="return=minimal")
    social._invalidate_stats()


def delete_post(post_id: int) -> None:
    _req("DELETE", "seruen_posts", params={"id": f"eq.{int(post_id)}"})
    social._invalidate_stats()


def offers() -> list[dict]:
    return _req("GET", "seruen_offers", params={
        "select": "id,kind,title,details,days,start_min,end_min,valid_until,active,created_at,"
                  "business:seruen_businesses(place_name,status)", "order": "created_at.desc", "limit": 300}) or []


def set_offer_active(offer_id: int, active: bool) -> None:
    _req("PATCH", "seruen_offers", params={"id": f"eq.{int(offer_id)}"}, body={"active": bool(active)},
         prefer="return=minimal")
    from .business import _invalidate
    _invalidate()


def users() -> list[dict]:
    profiles = _req("GET", "seruen_profiles", params={"select": "id,name,created_at", "order": "created_at.desc",
                                                       "limit": 1000}) or []
    counts: dict[str, int] = {}
    for p in _req("GET", "seruen_posts", params={"select": "author_id", "limit": 10000}) or []:
        counts[p["author_id"]] = counts.get(p["author_id"], 0) + 1
    code, data = auth._call("GET", "admin/users", key=auth.SERVICE, params={"page": 1, "per_page": 1000})
    accounts = {u["id"]: u for u in (data.get("users", []) if code < 300 and isinstance(data, dict) else [])}
    demo = social.demo_ids()
    out = []
    for p in profiles:
        a = accounts.get(p["id"], {})
        out.append({**p, "email": a.get("email"), "last_sign_in_at": a.get("last_sign_in_at"),
                    "role": (a.get("app_metadata") or {}).get("role"), "posts": counts.get(p["id"], 0),
                    "demo": p["id"] in demo})
    return out


def health() -> dict:
    meta, _ = load_pois()
    return {
        "catalog": {"total": meta["total"], "collected_at": meta["collected_at"][:10]},
        "database": social.status(),
        "keys": {
            "2ГИС": bool(config.DGIS_API_KEY),
            "Groq": bool(config.GROQ_API_KEY),
            "Supabase (сервер)": bool(auth.SERVICE),
            "ElevenLabs": bool(os.getenv("ELEVENLABS_API_KEY")),
        },
        "models": {"Подбор": config.RAG_MODEL, "Разбор запроса": config.INTENT_MODEL,
                   "Фото": os.getenv("GROQ_VISION_MODEL", ""), "Модерация": social.MODERATION_MODEL},
        "demo_accounts": len(social.demo_ids()),
    }

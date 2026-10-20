"""Вход и регистрация через Supabase Auth.

Регистрация идёт через Admin API серверным ключом сразу с подтверждённым email: бесплатный
Supabase шлёт лишь несколько писем в час, и на демо подтверждение по почте блокирует вход.
Для продакшена — включить подтверждение email.

Сервер сам проверяет access token на каждом запросе (/auth/v1/user, с коротким кешем),
поэтому выдать себя за другого пользователя, подставив чужой id, нельзя.
"""
import os
import re
import threading
import time

import requests

from . import config  # загружает .env до чтения ключей ниже
from .social import SocialError, get_profile, upsert_profile

URL = os.getenv("SUPABASE_URL", "").rstrip("/")
ANON = os.getenv("SUPABASE_KEY", "")            # публичный ключ: вход пользователей
SERVICE = os.getenv("SUPABASE_SERVICE_KEY", "")  # серверный: создание аккаунтов
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
MIN_PASSWORD = 8

_session = requests.Session()
_lock = threading.Lock()
_token_cache: dict[str, tuple[float, dict]] = {}
_signups: dict[str, list[float]] = {}


class AuthError(RuntimeError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _call(method: str, path: str, *, key: str = ANON, token: str | None = None, body=None, params=None):
    if not (URL and ANON and SERVICE):
        raise AuthError("Вход не настроен: нужны SUPABASE_URL, SUPABASE_KEY и SUPABASE_SERVICE_KEY", 503)
    headers = {"apikey": key, "Authorization": f"Bearer {token or key}", "Content-Type": "application/json"}
    try:
        r = _session.request(method, f"{URL}/auth/v1/{path}", json=body, params=params,
                             headers=headers, timeout=(4, 10))
    except requests.RequestException:
        raise AuthError("Нет связи с сервером входа, попробуйте ещё раз", 503) from None
    try:
        data = r.json() if r.content else {}
    except ValueError:
        data = {}
    return r.status_code, data


def _err_text(data: dict) -> str:
    return str(data.get("msg") or data.get("message") or data.get("error_description") or data.get("error") or "")


def _session_out(tok: dict, name: str) -> dict:
    return {
        "access_token": tok["access_token"],
        "refresh_token": tok["refresh_token"],
        "expires_at": tok.get("expires_at") or int(time.time()) + int(tok.get("expires_in", 3600)),
        "user": {"id": tok["user"]["id"], "email": tok["user"].get("email"), "name": name},
    }


def _clean_name(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip())


def register(name: str, email: str, password: str, ip: str) -> dict:
    name, email = _clean_name(name), (email or "").strip().lower()
    if not 2 <= len(name) <= 24:
        raise AuthError("Имя — от 2 до 24 символов")
    if not EMAIL_RE.match(email):
        raise AuthError("Проверьте email")
    if len(password or "") < MIN_PASSWORD:
        raise AuthError(f"Пароль — минимум {MIN_PASSWORD} символов")
    with _lock:  # аккаунты создаёт сервер, поэтому лимит на регистрации держим сами
        now = time.time()
        recent = [t for t in _signups.get(ip, []) if now - t < 3600]
        if len(recent) >= 5:
            raise AuthError("Слишком много регистраций с этого адреса, попробуйте позже", 429)
        _signups[ip] = recent + [now]

    code, data = _call("POST", "admin/users", key=SERVICE, body={
        "email": email, "password": password, "email_confirm": True, "user_metadata": {"name": name}})
    if code >= 300:
        text, ecode = _err_text(data).lower(), str(data.get("error_code") or data.get("code") or "")
        if ecode == "email_exists" or "already" in text:
            raise AuthError("Этот email уже зарегистрирован — войдите")
        if ecode == "weak_password" or "password" in text:
            raise AuthError("Пароль слишком простой — придумайте посложнее")
        raise AuthError(f"Не получилось зарегистрироваться ({code})", 502)
    try:
        upsert_profile(data["id"], name)
    except SocialError as e:
        raise AuthError(str(e), 502)
    return login(email, password)


def login(email: str, password: str) -> dict:
    email = (email or "").strip().lower()
    code, tok = _call("POST", "token", params={"grant_type": "password"},
                      body={"email": email, "password": password or ""})
    if code >= 300:
        if code == 429:
            raise AuthError("Слишком много попыток, подождите минуту", 429)
        if code in (400, 401, 422):
            raise AuthError("Неверный email или пароль", 401)
        raise AuthError(f"Не получилось войти ({code})", 502)
    user = tok["user"]
    try:
        prof = get_profile(user["id"])
        if not prof:  # аккаунт создан мимо Seruen — заводим профиль по имени из метаданных
            meta_name = _clean_name((user.get("user_metadata") or {}).get("name", ""))
            fallback = meta_name if 2 <= len(meta_name) <= 24 else email.split("@")[0][:24].ljust(2, "_")
            prof = upsert_profile(user["id"], fallback)
    except SocialError as e:
        raise AuthError(str(e), 502)
    return _session_out(tok, prof["name"])


def refresh(refresh_token: str) -> dict:
    code, tok = _call("POST", "token", params={"grant_type": "refresh_token"},
                      body={"refresh_token": refresh_token or ""})
    if code >= 300:
        raise AuthError("Сессия истекла, войдите снова", 401)
    prof = get_profile(tok["user"]["id"]) or {"name": tok["user"].get("email", "")}
    return _session_out(tok, prof["name"])


def logout(token: str) -> None:
    _call("POST", "logout", token=token)
    with _lock:
        _token_cache.pop(token, None)


def user_from_token(token: str | None) -> dict | None:
    """Пользователь по access token или None. Проверка у Supabase, кеш 60 секунд."""
    if not token:
        return None
    with _lock:
        hit = _token_cache.get(token)
        if hit and time.time() - hit[0] < 60:
            return hit[1]
    code, data = _call("GET", "user", token=token)
    if code >= 300 or not data.get("id"):
        return None
    # Роль ставится только сервером (app_metadata недоступна пользователю для записи) — python -m seruen.make_admin
    user = {"id": data["id"], "email": data.get("email"), "role": (data.get("app_metadata") or {}).get("role")}
    with _lock:
        if len(_token_cache) > 1000:
            _token_cache.clear()
        _token_cache[token] = (time.time(), user)
    return user

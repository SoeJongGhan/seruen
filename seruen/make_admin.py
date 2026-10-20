"""Создать администратора Seruen или выдать роль существующему аккаунту.

    python -m seruen.make_admin admin@example.com              # новый аккаунт со случайным паролем
    python -m seruen.make_admin admin@example.com --password X  # свой пароль / сменить пароль (минимум 8 символов)
    python -m seruen.make_admin user@mail.kz --revoke           # снять роль

Роль хранится в app_metadata Supabase: её может менять только сервер с секретным ключом,
поэтому выдать себе админку из браузера нельзя.
"""
import argparse
import secrets

from . import auth, social


def find_user(email: str) -> dict | None:
    code, data = auth._call("GET", "admin/users", key=auth.SERVICE, params={"page": 1, "per_page": 1000})
    users = data.get("users", []) if code < 300 and isinstance(data, dict) else []
    return next((u for u in users if (u.get("email") or "").lower() == email.lower()), None)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("email")
    ap.add_argument("--password", help="пароль для нового аккаунта; без него будет сгенерирован")
    ap.add_argument("--name", default="Администратор")
    ap.add_argument("--revoke", action="store_true", help="снять роль администратора")
    args = ap.parse_args()

    user = find_user(args.email)
    if args.revoke:
        if not user:
            raise SystemExit("Такого аккаунта нет")
        auth._call("PUT", f"admin/users/{user['id']}", key=auth.SERVICE, body={"app_metadata": {"role": None}})
        print(f"Роль администратора снята: {args.email}")
        return

    if user:
        body = {"app_metadata": {"role": "admin"}}
        if args.password:
            if len(args.password) < 8:
                raise SystemExit("Пароль — минимум 8 символов")
            body["password"] = args.password  # заодно сменить пароль
        code, _ = auth._call("PUT", f"admin/users/{user['id']}", key=auth.SERVICE, body=body)
        if code >= 300:
            raise SystemExit(f"Не получилось выдать роль ({code})")
        print(f"Готово: {args.email} — администратор. Пароль {'изменён' if args.password else 'прежний'}.")
        return

    password = args.password or secrets.token_urlsafe(12)
    if len(password) < 8:
        raise SystemExit("Пароль — минимум 8 символов")
    code, data = auth._call("POST", "admin/users", key=auth.SERVICE, body={
        "email": args.email, "password": password, "email_confirm": True,
        "user_metadata": {"name": args.name}, "app_metadata": {"role": "admin"}})
    if code >= 300:
        raise SystemExit(f"Не получилось создать аккаунт ({code}): {auth._err_text(data)}")
    social.upsert_profile(data["id"], args.name)
    print("Администратор создан.")
    print(f"  Email:  {args.email}")
    print(f"  Пароль: {password}" + ("" if args.password else "   <- сохраните, больше не покажем"))


if __name__ == "__main__":
    main()

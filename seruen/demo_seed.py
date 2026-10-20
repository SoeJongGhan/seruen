"""Демо-наполнение ленты для показа: 3 аккаунта, подсказки и взаимные лайки.

Это не отзывы реальных людей. Аккаунты помечены как демо (в ленте у них плашка «демо»),
а тексты — подсказки, составленные только по данным 2ГИС: описаниям, атрибутам, часам работы.
Никаких «я был, было вкусно».

    python -m seruen.demo_seed            # создать (повторный запуск ничего не дублирует)
    python -m seruen.demo_seed --remove   # удалить аккаунты вместе с их постами и лайками
"""
import json
import secrets
import sys

from . import auth, config, social
from .recommend import load_pois

DEMO_PATH = config.DATA_DIR / "demo_accounts.json"

ACCOUNTS = {
    "aigerim": "Айгерим",
    "daniyar": "Данияр",
    "madina": "Мадина",
}

# (автор, id места в 2ГИС, текст) — каждый факт есть в карточке места в data/pois.json.
POSTS = [
    ("aigerim", "70000001021365759",
     "Наверху Байтерека крытая смотровая площадка, а на высоте 97 метров — композиция «Заботливые руки». "
     "Высота не случайная: 1997 — год, когда Астана стала столицей."),
    ("daniyar", "70000001095205402",
     "Кофейня-коворкинг: бесплатный Wi-Fi и около 20 мест. Открыта с 9 до 22 — удобно, если нужно посидеть с ноутбуком."),
    ("madina", "70000001053020549",
     "С детьми: батуты, детские площадки и аниматор, внутри есть кафе. Есть пандус и широкий лифт — удобно с коляской."),
    ("aigerim", "70000001018608940",
     "В Национальном музее есть интерактивные экспонаты, пандус, широкий лифт и туалет для маломобильных посетителей. "
     "Музей три года подряд получал премию 2ГИС."),
    ("daniyar", "70000001059834146",
     "Работает до 2 ночи, бывает живая музыка, есть настольные игры и летняя веранда. Вариант на вечер компанией."),
    ("madina", "70000001019586912",
     "Парк на берегу Ишима: велодорожки, верёвочный парк, карусели и детские площадки. Реконструирован в 2018 году."),
    ("daniyar", "70000001067331940",
     "Коктейльный бар открывается в 19:00 и работает до 3 ночи. Можно прийти с собакой."),
    ("aigerim", "9570844992864353",
     "Композиция «Счастье моё» — вход в Парк влюблённых. Отсюда удобно начать неспешную прогулку по парку."),
    ("madina", "70000001079969431",
     "Есть детское меню, завтраки и бесплатный Wi-Fi. Открыто с 8 утра — можно позавтракать перед прогулкой."),
    ("daniyar", "70000001110382562",
     "Мультимедийный музей в помещении — запасной план, если на улице холодно или ветрено."),
]

# Кто какой пост лайкает (по индексу в POSTS).
LIKES = {
    0: ["daniyar", "madina"],
    2: ["aigerim"],
    3: ["madina"],
    4: ["aigerim", "madina"],
    1: ["madina"],
    5: ["aigerim", "daniyar"],
}


def load_demo() -> dict:
    return json.loads(DEMO_PATH.read_text("utf-8")) if DEMO_PATH.exists() else {}


def create() -> None:
    demo = load_demo()
    if demo.get("posts"):
        print("Демо-данные уже созданы. Удалить: python -m seruen.demo_seed --remove")
        return
    _, pois = load_pois()
    by_id = {p["id"]: p for p in pois}
    users = {}
    for key, name in ACCOUNTS.items():
        email = f"seruen.demo.{key}@example.com"
        # Пароль случайный и нигде не сохраняется: входить в демо-аккаунты не нужно.
        session = auth.register(name, email, secrets.token_urlsafe(18), ip="demo-seed")
        users[key] = {"id": session["user"]["id"], "email": email, "name": name}
        print(f"аккаунт: {name} <{email}>")
    demo = {"accounts": list(users.values()), "posts": []}
    DEMO_PATH.write_text(json.dumps(demo, ensure_ascii=False, indent=1), "utf-8")

    for author, place_id, text in POSTS:
        post = social.create_post(users[author]["id"], by_id[place_id], text)  # с модерацией, как у всех
        demo["posts"].append(post["id"])
        print(f"пост: {users[author]['name']} -> {by_id[place_id]['name']}")
    for idx, likers in LIKES.items():
        for who in likers:
            social.toggle_like(demo["posts"][idx], users[who]["id"])
    DEMO_PATH.write_text(json.dumps(demo, ensure_ascii=False, indent=1), "utf-8")
    print(f"Готово: {len(users)} аккаунта, {len(demo['posts'])} постов, "
          f"{sum(len(v) for v in LIKES.values())} лайков. Список — {DEMO_PATH}")


def remove() -> None:
    demo = load_demo()
    for acc in demo.get("accounts", []):
        social._req("DELETE", "seruen_profiles", params={"id": f"eq.{acc['id']}"})  # каскадом — посты и лайки
        auth._call("DELETE", f"admin/users/{acc['id']}", key=auth.SERVICE)
        print(f"удалён: {acc['name']} <{acc['email']}>")
    DEMO_PATH.unlink(missing_ok=True)
    print("Демо-данные удалены.")


if __name__ == "__main__":
    remove() if "--remove" in sys.argv else create()

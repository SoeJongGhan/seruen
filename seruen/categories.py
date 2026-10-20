"""Таксономия мест и то, как каждая категория собирается из 2ГИС.

Поиск 2ГИС нечёткий (по запросу «театр» он находит и лишнее), поэтому категорию
определяем не по запросу, а по рубрикам объекта: `match` — подстроки рубрик,
`exclude` — подстроки, которые категорию отменяют.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Category:
    key: str
    label: str
    query: str
    match: tuple[str, ...]
    exclude: tuple[str, ...] = ()
    type: str = "branch"
    # grid — обход города сеткой (мест много), city — один запрос на весь город (мест мало).
    scope: str = "city"
    max_pages: int = 5
    sort: str | None = None
    # Дополнительные запросы той же категории (у «парка» мало результатов без «сквера»).
    also: tuple[str, ...] = ()


CATEGORIES: list[Category] = [
    # Плотные категории — обходим сеткой.
    Category("sight", "Достопримечательности", "достопримечательности",
             match=("интересные здания", "памятник", "достопримечательност", "монумент", "скульптур"),
             type="attraction", scope="grid", max_pages=5),
    Category("park", "Парки и скверы", "парк",
             match=("парки", "скверы", "ботанические сады", "бульвар", "набережн"),
             exclude=("такс", "автопарк", "детские сады", "аквапарк"),
             type="branch,attraction", scope="grid", max_pages=2, also=("сквер",)),
    Category("coffee", "Кофейни", "кофейня", match=("кофейн",), scope="grid", max_pages=2, sort="rating"),
    Category("cafe", "Кафе", "кафе", match=("кафе",), exclude=("антикафе",), scope="grid", max_pages=2, sort="rating"),
    Category("restaurant", "Рестораны", "ресторан", match=("ресторан",), scope="grid", max_pages=2, sort="rating"),
    Category("bar", "Бары", "бар", match=("бары", "пабы"), exclude=("суши",), scope="grid", max_pages=1, sort="rating"),
    Category("kids", "Для детей", "детский развлекательный центр",
             match=("детские игровые", "аттракцион", "батут", "детские развлекательн"), scope="grid", max_pages=1),

    # Редкие категории — один запрос на весь город.
    Category("museum", "Музеи", "музей", match=("музе",), type="branch,attraction"),
    Category("gallery", "Галереи и выставки", "галерея", match=("выставк", "галере"), max_pages=3),
    Category("theatre", "Театры и концерты", "театр", match=("театр", "концертные залы", "филармони"), max_pages=4),
    Category("cinema", "Кино", "кинотеатр", match=("кинотеатр",), max_pages=3),
    Category("viewpoint", "Смотровые площадки", "смотровая площадка", match=("смотров",), type="branch,attraction"),
    Category("mall", "ТРЦ", "торгово-развлекательный центр", match=("торгово-развлекательн", "торговые центры"), max_pages=3),
    Category("anticafe", "Антикафе", "антикафе", match=("антикафе",)),
    Category("coworking", "Коворкинги", "коворкинг", match=("коворкинг",)),
    Category("quest", "Квесты", "квест", match=("квест",)),
    Category("bowling", "Боулинг", "боулинг", match=("боулинг",), max_pages=1),
    Category("karaoke", "Караоке", "караоке", match=("караоке",), max_pages=2),
    Category("nightclub", "Ночные клубы", "ночной клуб", match=("ночные клубы",), max_pages=2),
    Category("skating", "Катки", "каток", match=("каток", "катки", "ледов"), type="branch,attraction", max_pages=1),
    Category("aquapark", "Аквапарки", "аквапарк", match=("аквапарк",), max_pages=1),
    Category("zoo", "Зоопарки и океанариумы", "океанариум", match=("зоопарк", "океанариум"), max_pages=1),
    Category("bookstore", "Книжные", "книжный магазин", match=("книги", "книжн"), max_pages=2),
]

BY_KEY = {c.key: c for c in CATEGORIES}
LABELS = {c.key: c.label for c in CATEGORIES}


def classify(rubrics: list[str], item_type: str | None) -> list[str]:
    """Категории объекта по его рубрикам 2ГИС."""
    low = [r.lower() for r in rubrics]
    keys = []
    for cat in CATEGORIES:
        if any(ex in r for r in low for ex in cat.exclude):
            continue
        if any(m in r for r in low for m in cat.match):
            keys.append(cat.key)
    if item_type == "attraction" and "sight" not in keys:
        keys.insert(0, "sight")
    return keys

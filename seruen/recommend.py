"""RAG-ядро: запрос -> намерение (LLM) -> отбор POI из базы (код) -> рекомендации (LLM).

Факты (расстояние, время в пути, часы работы, рейтинг, ссылка) всегда берутся из базы
и считаются кодом. LLM только выбирает из найденных кандидатов и объясняет выбор,
поэтому выдумать место или «открыто сейчас» она не может.
"""
import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache

from groq import Groq, RateLimitError

from . import config, routing, social
from .categories import BY_KEY, LABELS
from .poi import ASTANA_TZ, hours_today, open_status
from .weather import get_weather

# Потребности пользователя -> подстроки атрибутов 2ГИС.
NEEDS = {
    "laptop": ("можно с ноутбуком, розетки", ("ноутбук", "розетк")),
    "wifi": ("Wi-Fi", ("wi-fi",)),
    "kids": ("детская комната, детское меню", ("детск",)),
    "accessible": ("доступная среда", ("инвалид", "доступный вход", "пандус")),
    "terrace": ("летняя веранда", ("веранд", "террас")),
    "live_music": ("живая музыка", ("живая музыка",)),
    "pets": ("можно с собакой", ("с собак", "с животн")),
    "breakfast": ("завтраки", ("завтрак",)),
    "vegan": ("вегетарианское меню", ("вегетариан", "веган")),
}

# Скорость (м/мин), коэффициент извилистости пути и фиксированные минуты (ожидание, парковка).
MODES = {
    "walk": {"label": "пешком", "speed": 75, "detour": 1.3, "overhead": 0, "radius": (500, 2500)},
    "transit": {"label": "транспортом", "speed": 250, "detour": 1.3, "overhead": 8, "radius": (1500, 7000)},
    "car": {"label": "на машине", "speed": 400, "detour": 1.4, "overhead": 5, "radius": (2000, 12000)},
}

# Места без расписания, которые и так открыты всегда: улица, парк, памятник.
OUTDOOR = {"sight", "park", "viewpoint"}
WEEKDAYS_RU = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]


@dataclass
class Intent:
    categories: list[str] = field(default_factory=list)
    needs: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    time_budget_min: int | None = None
    mode: str = "walk"
    group: str | None = None
    landmark: str | None = None
    route: bool = False
    stroll: bool = False
    group_size: int = 1
    language: str = "ru"


@lru_cache(maxsize=1)
def load_pois() -> tuple[dict, list[dict]]:
    data = json.loads(config.POIS_PATH.read_text("utf-8"))
    return data["meta"], data["pois"]


@lru_cache(maxsize=1)
def _client() -> Groq:
    if not config.GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY не задан в .env")
    return Groq(api_key=config.GROQ_API_KEY)


def _chat_json(model: str, system: str, user: str, effort: str = "low") -> tuple[dict, str]:
    """JSON-ответ модели и имя модели, которая ответила.

    У бесплатного Groq лимит ~8000 токенов в минуту на модель, а ответ занимает ~3000.
    Вместо ожидания при упоре в лимит сразу переходим на запасную модель с отдельным лимитом.
    """
    chain = [model] + ([config.INTENT_MODEL] if model != config.INTENT_MODEL else [])
    for i, m in enumerate(chain):
        last = i == len(chain) - 1
        try:
            resp = _client().with_options(max_retries=2 if last else 0).chat.completions.create(
                model=m,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                response_format={"type": "json_object"},
                reasoning_effort=effort,
                temperature=0.3,
            )
            return json.loads(resp.choices[0].message.content), m
        except RateLimitError:
            if last:
                raise RuntimeError("Groq: исчерпан лимит запросов в минуту, попробуйте через минуту") from None


def distance_m(lat1, lon1, lat2, lon2) -> float:
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def travel_min(dist: float, mode: str) -> int:
    m = MODES[mode]
    return max(1, round(dist * m["detour"] / m["speed"] + m["overhead"]))


# ---------- 1. Разбор запроса ----------

INTENT_PROMPT = """Ты разбираешь запрос жителя или туриста Астаны о том, куда сходить.
Верни JSON с полями:
- categories: список ключей категорий, подходящих запросу (0–5), только из: {categories}
- needs: ключи потребностей, только из: {needs}; только то, что человек явно попросил, не додумывай
- keywords: 0–5 основ слов от 4 букв для поиска по описаниям и атрибутам (например "кофе", "розетк",
  "интерактив", "смотров"); не включай названия мест и ориентиров
- time_budget_min: сколько минут у человека всего, число или null; если диапазон ("30–60 минут") — верхняя граница
- mode: "walk" | "transit" | "car" (по умолчанию "walk")
- group: "kids" | "couple" | "friends" | "tourist" | "solo" | null
- landmark: место, рядом с которым человек находится, если он его назвал ("Mega Silk Way", "Экспо"), иначе null
- route: true, если просят маршрут или программу из нескольких мест подряд
- stroll: true, если сама прогулка — цель ("прогуляться", "погулять", "пройтись")
- group_size: сколько человек идёт, включая самого пользователя (по умолчанию 1)
Если запрос размытый ("что-нибудь интересное"), выбери разнообразные категории."""


def parse_intent(text: str) -> Intent:
    system = INTENT_PROMPT.format(
        categories=", ".join(f"{k} ({v})" for k, v in LABELS.items()),
        needs=", ".join(f"{k} ({v[0]})" for k, v in NEEDS.items()),
    )
    raw, _ = _chat_json(config.INTENT_MODEL, system, text)
    budget = raw.get("time_budget_min")
    return Intent(
        categories=[c for c in raw.get("categories") or [] if c in BY_KEY],
        needs=[n for n in raw.get("needs") or [] if n in NEEDS],
        keywords=[str(k).lower() for k in raw.get("keywords") or [] if len(str(k)) >= 4][:5],
        time_budget_min=int(budget) if isinstance(budget, (int, float)) and budget > 0 else None,
        mode=raw.get("mode") if raw.get("mode") in MODES else "walk",
        group=raw.get("group"),
        landmark=raw.get("landmark") or None,
        route=bool(raw.get("route")),
        stroll=bool(raw.get("stroll")),
        group_size=max(1, min(20, _as_int(raw.get("group_size"), 1))),
        language=detect_language(text),
    )


def _as_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def detect_language(text: str) -> str:
    """По алфавиту надёжнее, чем по ответу модели: 20b иногда путает язык."""
    low = text.lower()
    if any(ch in "әғқңөұүһі" for ch in low):
        return "kk"
    if not any("а" <= ch <= "я" or ch == "ё" for ch in low):
        return "en"
    return "ru"


def resolve_landmark(name: str) -> dict | None:
    """Ищет названный ориентир в собранной базе (без запросов к 2ГИС)."""
    _, pois = load_pois()
    needle = name.lower().replace("ё", "е")
    hits = [p for p in pois if needle in p["name"].lower().replace("ё", "е")]
    if not hits:
        return None
    best = max(hits, key=lambda p: (p["reviews"], p["description"] is not None))
    return {"name": best["name"], "lat": best["lat"], "lon": best["lon"]}


# ---------- 2. Отбор кандидатов ----------

def search_radius(intent: Intent, weather: dict | None = None) -> int:
    lo, hi = MODES[intent.mode]["radius"]
    if not intent.time_budget_min:
        reach = hi if intent.mode != "walk" else 1500
    else:
        # На дорогу в одну сторону — не больше трети бюджета. Если цель — сама прогулка, дорога
        # и есть занятие, поэтому уходить можно дальше.
        share = 0.5 if intent.stroll else 0.33
        reach = MODES[intent.mode]["speed"] * intent.time_budget_min * share / MODES[intent.mode]["detour"]
    if weather and weather["harsh"] and intent.mode == "walk":
        reach *= 0.7  # в мороз и дождь далеко пешком не пойдёшь
    return int(min(hi, max(lo, reach)))


def _text(p: dict) -> str:
    return " ".join([p["name"], *p["rubrics"], *p["attributes"], p["description"] or ""]).lower()


def score(p: dict, dist: float, radius: int, intent: Intent, status: dict,
          weather: dict | None = None, community: dict | None = None) -> tuple[float, list[str]]:
    """Оценка кандидата и список совпадений, объясняющих, почему он попал в выдачу."""
    matched = []
    s = 1.0 - dist / radius
    if p["rating"]:
        weight = min(1.0, math.log10(p["reviews"] + 1) / 2.5)
        s += 0.8 * max(-1.0, min(1.0, p["rating"] - 4.0)) * weight
    text = _text(p)
    for need in intent.needs:
        hit = next((a for a in p["attributes"] if any(sub in a.lower() for sub in NEEDS[need][1])), None)
        if hit:
            s += 0.8
            matched.append(hit)
    for kw in intent.keywords:
        if kw and kw in text:
            s += 0.4
            matched.append(kw)
    if p["description"]:
        s += 0.2
    outdoor = p["schedule"] is None and bool(OUTDOOR & set(p["categories"]))
    if intent.stroll and outdoor:
        s += 0.6
    if weather and outdoor:
        s += -0.9 if weather["harsh"] else 0.3 if weather["pleasant"] else 0
    if status["open"] is None and not OUTDOOR & set(p["categories"]):
        s -= 0.3  # честно не знаем, работает ли
    if community:
        # Советы людей из ленты — мягкий сигнал: не перебивает расстояние и открытость.
        s += 0.25 * math.log2(1 + community["posts"] + community["likes"])
        matched.append("советуют в ленте")
    return s, matched


def in_season(p: dict, now: datetime) -> bool:
    """Сезонные объекты Астаны: фонтаны работают примерно с мая по сентябрь,
    открытые катки (без расписания) — с декабря по март."""
    text = (p["name"] + " " + " ".join(p["rubrics"])).lower()
    if "фонтан" in text and not 5 <= now.month <= 9:
        return False
    # Смотрим и на название: у части катков-достопримечательностей в 2ГИС нет рубрик.
    if ("каток" in text or "катки" in text) and p["schedule"] is None and 4 <= now.month <= 11:
        return False
    return True


def retrieve(intent: Intent, lat: float, lon: float, now: datetime, limit: int = 12,
             weather: dict | None = None, funnel: dict | None = None) -> tuple[list[dict], int]:
    """Кандидаты и радиус поиска. В funnel (если передан) — сколько мест отсеял каждый фильтр."""
    _, pois = load_pois()
    radius = search_radius(intent, weather)
    wanted = set(intent.categories)
    community = social.place_stats()
    min_left = 30 if not intent.time_budget_min else min(60, intent.time_budget_min // 2)

    for attempt in range(2):  # если рядом пусто — один раз расширяем радиус
        scored = []
        counts = {"total": len(pois), "category": 0, "nearby": 0, "open": 0}
        for p in pois:
            if wanted and not wanted & set(p["categories"]):
                continue
            counts["category"] += 1
            dist = distance_m(lat, lon, p["lat"], p["lon"])
            if dist > radius or not in_season(p, now):
                continue
            counts["nearby"] += 1
            status = open_status(p["schedule"], now)
            if status["open"] is False:
                continue
            if status["closes_in"] is not None and status["closes_in"] < min_left + travel_min(dist, intent.mode):
                continue  # закроется раньше, чем человек успеет дойти и побыть там
            counts["open"] += 1
            s, matched = score(p, dist, radius, intent, status, weather, community.get(p["id"]))
            scored.append((s, p, dist, status, matched))
        if len(scored) >= 5 or attempt:
            break
        radius *= 2
    if funnel is not None:
        funnel.update(counts)

    scored.sort(key=lambda x: x[0], reverse=True)
    # Разнообразие: сначала не больше cap мест одной основной категории,
    # потом оставшиеся слоты добираем лучшими из отложенных.
    cap = max(4, limit // max(1, len(wanted) or 4))
    per_cat: dict[str, int] = {}
    picked, deferred = [], []
    for row in scored:
        main = next((c for c in row[1]["categories"] if c in wanted), row[1]["categories"][0])
        if per_cat.get(main, 0) < cap and len(picked) < limit:
            per_cat[main] = per_cat.get(main, 0) + 1
            picked.append((main, row))
        else:
            deferred.append((main, row))
    picked += deferred[: limit - len(picked)]

    out = []
    for main, (s, p, dist, status, matched) in picked:
        outdoor = p["schedule"] is None and bool(OUTDOOR & set(p["categories"]))
        out.append({
            **p,
            "main_category": main,
            "distance_m": round(dist),
            "travel_min": travel_min(dist, intent.mode),
            "outdoor": outdoor,
            "open_now": status["open"],
            "closes_in": status["closes_in"],
            "hours_today": "под открытым небом" if outdoor else hours_today(p["schedule"], now),
            "matched": matched,
            "community": community.get(p["id"]),
            "score": round(s, 2),
        })
    return out, radius


# ---------- 3. Генерация ----------

ANSWER_PROMPT = """Ты — Seruen, городской гид по Астане. Тебе дают запрос человека и список
мест-кандидатов из базы 2ГИС с уже посчитанными фактами. Выбери 3 лучших места — меньше только
если подходящих кандидатов действительно меньше (для маршрута — в удобном порядке обхода) и верни JSON:
{{
 "intro": "одна короткая фраза по делу, до 12 слов, без восклицательных знаков",
 "items": [{{"ref": "ref кандидата, например c3", "name": "name этого же кандидата",
            "why": "1–2 предложения: что это за место и чем оно подходит под этот запрос, только по данным кандидата",
            "visit_min": минут на месте, "plan": "что конкретно там сделать", "caveat": "оговорка или null"}}],
 "idea": {{"title": "...", "text": "..."}} или null
}}
Правила:
- Рекомендуй только места из списка кандидатов; ref и name бери из одной и той же записи.
- Не предлагай место, где человек уже находится (поле start).
- Не придумывай фактов: выставок, интерактивов, меню, шоу, цен, которых нет в данных кандидата.
  Если конкретики нет — план должен быть общим ("осмотреть", "сделать фото"), а не выдуманным.
- Если человек хочет прогуляться, в основе — парки, достопримечательности, виды; кафе — как остановка по пути.
- Предпочитай разнообразие: не три места одного типа, если запрос этого прямо не просит.
- status "под открытым небом" — памятник или парк: про часы работы не пиши.
- status "часы работы неизвестны" — в caveat напиши, что лучше уточнить перед визитом.
- status "скоро закрывается" — предупреди в caveat. Иначе про закрытие не пиши.
- Учитывай время года (дата в поле now): в Астане фонтаны и летние веранды работают примерно
  с мая по сентябрь, зимой холодно и важны места в помещении.
- Учитывай погоду (поле weather): в мороз, ветер или дождь — места в помещении, улица — коротко
  и по пути; в хорошую погоду — смелее на улицу. Если погода повлияла на выбор, скажи об этом в intro.
- Если group_size > 1 — выбирай места, удобные компании, и объясни, чем подходит всей группе.
- Поле community — место советуют люди в ленте Seruen; это можно упомянуть как довод.
- Учитывай бюджет времени: дорога туда (travel_min) + visit_min должны в него укладываться.
  Если у человека дедлайн (вылет, поезд), оставь запас на дорогу и скажи об этом.
- Не повторяй в why рейтинг, часы работы, расстояние и минуты в пути — всё это уже есть в карточке.
- "idea" — необязательная своя идея (например, прогуляться по набережной между местами); она будет
  помечена как идея ИИ, не данные 2ГИС. Не выдавай её за конкретное заведение.
- Все текстовые поля (intro, why, plan, caveat, idea) пиши на языке: {language}. Названия мест не переводи.
- Тон — как у местного, который советует другу: просто, конкретно, без рекламы. Не используй слова
  «идеально», «идеальный», «идеален», «отличный выбор», «насладиться», «уютный», «уютная атмосфера», «окунуться»,
  «незабываемый», «уникальный», «атмосферный», «прекрасно». Не начинай с «Конечно» или «Отлично»."""

# Модель всё равно иногда дописывает в why часы и рейтинг, которые уже есть в карточке.
# Вырезаем только самостоятельные хвосты «, открыта до 23:00» — из середины фразы не трогаем,
# чтобы не ломать грамматику.
_REDUNDANT = re.compile(
    r",\s*(?:и\s+)?(?:сейчас\s+)?(?:открыт[аоы]?|работает)(?:\s+сейчас)?\s+до\s+(?:\d{1,2}:\d{2}|полуночи|утра)(?=\s*(?:[.;]|$))"
    r"|,\s*(?:с\s+)?(?:высоким\s+)?рейтинг(?:ом)?\s+\d(?:[.,]\d)?(?:\s*★)?(?=\s*(?:[.;]|$))",
    re.IGNORECASE)


# Штампы, которые модель пишет в любых падежах вопреки запрету в промпте: прилагательное просто убираем
# («уютное кафе» -> «кафе»).
_CLICHE = re.compile(r"\b(?:уютн|идеальн|атмосферн|незабываем|уникальн)[а-яё]*\s+", re.IGNORECASE)


def _tidy(text: str | None) -> str | None:
    if not text:
        return text
    out = _CLICHE.sub("", _REDUNDANT.sub("", text)).strip()
    out = re.sub(r"\s+([,.])", r"\1", out)
    out = re.sub(r",\s*\.", ".", out).strip(" ,")
    return out[0].upper() + out[1:] if out else text

LANGUAGE_NAMES = {"ru": "русский", "en": "English", "kk": "қазақ тілі (казахский)"}


def _candidate_view(c: dict, ref: str) -> dict:
    # Короткий ref вместо 17-значного id 2ГИС: модель копирует его без ошибок.
    return {
        "ref": ref,
        "name": c["name"],
        "category": LABELS[c["main_category"]],
        "rubrics": c["rubrics"][:4],
        "distance_m": c["distance_m"],
        "travel_min": c["travel_min"],
        "rating": c["rating"],
        "reviews": c["reviews"],
        "status": status_text(c),
        "attributes": c["attributes"][:8],
        "description": (c["description"] or "")[:200] or None,
        # Только счётчики, не тексты отзывов: пользовательский текст в промпте — риск подмены инструкций.
        **({"community": f"советуют в ленте Seruen: {c['community']['posts']} отзыв(ов), "
                         f"{c['community']['likes']} лайков"} if c.get("community") else {}),
    }


def status_text(c: dict) -> str:
    """Статус работы готовой фразой: сырые минуты модель путает с секундами."""
    if c["outdoor"]:
        return "под открытым небом, часы не нужны"
    if c["open_now"] is None:
        return "часы работы неизвестны"
    if c["closes_in"] is None:
        return "открыто круглосуточно"
    h, m = divmod(c["closes_in"], 60)
    left = f"{h} ч {m} мин" if h else f"{m} мин"
    soon = " — скоро закрывается" if c["closes_in"] < 90 else ""
    return f"открыто сейчас, сегодня {c['hours_today']}, до закрытия {left}{soon}"


_KK = str.maketrans("әөүұқғңһіё", "аоуукгнхие")


def _norm(name: str) -> str:
    # Казахские буквы приводим к русским: «Бәйтерек» и «Байтерек» — одно место.
    return "".join(ch for ch in name.lower().translate(_KK) if ch.isalnum())


def _match(item: dict, by_ref: dict, by_name: dict) -> dict | None:
    """Кандидат, на которого ссылается модель. Ref и имя должны указывать на одно место:
    если они расходятся, верим имени (объяснение написано про него), иначе отбрасываем."""
    by_r = by_ref.get(str(item.get("ref", "")).strip())
    name = _norm(str(item.get("name") or ""))
    # Сравниваем имена, а не объекты: у сетей (Drinkit и т.п.) несколько филиалов с одним именем.
    if by_r and (not name or _norm(by_r["name"]) == name):
        return by_r
    return by_name.get(name)


def generate(text: str, intent: Intent, candidates: list[dict], now: datetime, start: str,
             weather: dict | None = None) -> dict:
    refs = {f"c{i}": c for i, c in enumerate(candidates, 1)}
    payload = {
        "request": text,
        # Название стартовой точки, но не координаты: модели они не нужны.
        "start": start,
        "now": f"{now:%d.%m.%Y %H:%M}, {WEEKDAYS_RU[now.weekday()]}",
        "weather": f"{weather['label']}; {weather['advice']}" if weather else "нет данных",
        "mode": MODES[intent.mode]["label"],
        "time_budget_min": intent.time_budget_min,
        "group": intent.group,
        "group_size": intent.group_size,
        "route": intent.route,
        "stroll": intent.stroll,
        "candidates": [_candidate_view(c, ref) for ref, c in refs.items()],
    }
    raw, model = _chat_json(config.RAG_MODEL,
                            ANSWER_PROMPT.format(language=LANGUAGE_NAMES.get(intent.language, intent.language)),
                            json.dumps(payload, ensure_ascii=False), effort="low")

    by_name: dict[str, dict] = {}
    for c in candidates:  # при совпадении имён побеждает филиал с лучшей оценкой
        by_name.setdefault(_norm(c["name"]), c)
    items = []
    for it in raw.get("items") or []:
        c = _match(it, refs, by_name)
        if not c or any(x["id"] == c["id"] for x in items):
            continue  # модель сослалась на место не из выдачи — отбрасываем
        caveat = it.get("caveat") or None
        if caveat and c["outdoor"] and any(w in caveat.lower() for w in ("час", "hour", "уақыт")):
            caveat = None
        items.append({**c, "why": _tidy(it.get("why")), "visit_min": it.get("visit_min"),
                      "plan": it.get("plan"), "caveat": caveat})
    return {"intro": _tidy(raw.get("intro")), "items": items[:3], "idea": raw.get("idea"), "model": model}


def attach_routes(origin: dict, items: list[dict], mode: str, chain: bool) -> list[dict]:
    """Реальные маршруты 2ГИС: от старта до каждого места или, для маршрута, цепочкой
    старт -> 1 -> 2 -> 3. Запросы идут параллельно. Если 2ГИС не ответил — оценка по прямой."""
    ends = [(it["lat"], it["lon"]) for it in items]
    starts = [(origin["lat"], origin["lon"])] + (ends[:-1] if chain else [(origin["lat"], origin["lon"])] * (len(items) - 1))
    pairs = list(zip(starts, ends))
    with ThreadPoolExecutor(max_workers=3) as pool:
        found = list(pool.map(lambda ab: routing.route(ab[0], ab[1], mode), pairs))
    legs = []
    for it, (a, b), r in zip(items, pairs, found):
        if r:
            leg = {"distance_m": r["distance_m"], "travel_min": r["duration_min"],
                   "geometry": r["geometry"], "summary": r["summary"], "real": True}
        else:
            d = distance_m(*a, *b)
            leg = {"distance_m": round(d), "travel_min": travel_min(d, mode),
                   "geometry": [list(a), list(b)], "summary": None, "real": False}
        it["leg"] = leg
        legs.append({"to": it["name"], **leg})
    return legs


def _answer(text: str, intent: Intent, candidates: list[dict], now: datetime, origin: dict,
            weather: dict | None, timings: dict) -> dict:
    if not candidates:
        return {"intro": None, "items": [], "idea": None, "model": None, "legs": []}
    t = time.perf_counter()
    answer = generate(text, intent, candidates, now, origin["name"], weather)
    timings["generate"] = round(time.perf_counter() - t, 1)
    t = time.perf_counter()
    answer["legs"] = attach_routes(origin, answer["items"], intent.mode, chain=intent.route)
    timings["routes"] = round(time.perf_counter() - t, 1)
    return answer


def recommend(text: str, lat: float | None = None, lon: float | None = None,
              now: datetime | None = None, overrides: dict | None = None, place: str | None = None,
              weather: dict | None = None) -> dict:
    """Полный цикл RAG. overrides — явные настройки из интерфейса (mode, time_budget_min, needs,
    group_size); weather — готовое состояние погоды (иначе берётся прогноз Open-Meteo)."""
    now = now or datetime.now(ASTANA_TZ)
    timings = {}
    t = time.perf_counter()
    intent = parse_intent(text)
    timings["intent"] = round(time.perf_counter() - t, 1)
    for k, v in (overrides or {}).items():
        if k == "needs":
            intent.needs = sorted(set(intent.needs) | set(v))
        elif v is not None:
            setattr(intent, k, v)
    if intent.stroll and intent.categories:
        # Прогулка без парков и достопримечательностей — не прогулка; 20b иногда их теряет.
        intent.categories = sorted(set(intent.categories) | {"sight", "park"})

    origin = {"name": place or "ваша точка", "lat": lat or config.DEFAULT_LAT, "lon": lon or config.DEFAULT_LON}
    if intent.landmark:
        found = resolve_landmark(intent.landmark)
        if found:
            origin = found
    if weather is None:
        weather = get_weather(origin["lat"], origin["lon"], now)

    t = time.perf_counter()
    funnel: dict = {}
    candidates, radius = retrieve(intent, origin["lat"], origin["lon"], now, weather=weather, funnel=funnel)
    # Место, где человек уже стоит, не рекомендуем («вы у Mega Silk Way» -> не «сходите в Mega Silk Way»).
    here = _norm(origin["name"])
    candidates = [c for c in candidates if not (here and c["distance_m"] < 150 and here in _norm(c["name"]))]
    timings["retrieve"] = round(time.perf_counter() - t, 2)
    answer = _answer(text, intent, candidates, now, origin, weather, timings)
    funnel.update(candidates=len(candidates), chosen=len(answer["items"]))
    return {
        "text": text,
        "intent": intent.__dict__,
        "origin": origin,
        "weather": weather,
        "radius_m": radius,
        "candidates": candidates,
        "now": now.isoformat(timespec="minutes"),
        "timings": timings,
        "funnel": funnel,
        "shown": [it["id"] for it in answer["items"]],
        **answer,
    }


def more(prev: dict) -> dict:
    """«Другие варианты»: тот же запрос, без нового разбора и поиска — из ещё не показанных кандидатов."""
    shown = set(prev["shown"])
    rest = [c for c in prev["candidates"] if c["id"] not in shown]
    timings = {"intent": 0, "retrieve": 0}
    answer = _answer(prev["text"], Intent(**prev["intent"]), rest, datetime.fromisoformat(prev["now"]),
                     prev["origin"], prev["weather"], timings)
    return {**prev, **answer, "timings": timings, "funnel": {**prev.get("funnel", {}), "chosen": len(answer["items"])},
            "shown": [*shown, *(it["id"] for it in answer["items"])]}

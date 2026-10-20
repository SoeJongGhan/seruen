"""Клиент 2ГИС Places API с дисковым кешем.

Демо-ключ ограничен: page_size <= 10, page <= 5, то есть не больше 50 объектов на запрос.
Каждый ответ кешируется, поэтому повторный запуск сбора не тратит квоту.
"""
import hashlib
import json
import threading
import time
from pathlib import Path

import requests

ITEMS_URL = "https://catalog.api.2gis.com/3.0/items"
PAGE_SIZE = 10
MAX_PAGE = 5
FIELDS = ",".join([
    "items.point",
    "items.rubrics",
    "items.schedule",
    "items.reviews",
    "items.address",
    "items.full_address_name",
    "items.attribute_groups",
    "items.description",
])


class QuotaExceeded(RuntimeError):
    """Кончился лимит ключа или бюджет запросов на этот запуск."""


class NetworkError(RuntimeError):
    """2ГИС недоступен после нескольких попыток."""


class DgisClient:
    def __init__(self, key: str, cache_dir: Path, max_requests: int | None = None, retries: int = 4):
        if not key:
            raise ValueError("DGIS_API_KEY не задан в .env")
        self.key = key
        self.cache_dir = cache_dir / "dgis"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.max_requests = max_requests
        self.retries = retries
        self.session = requests.Session()  # keep-alive: без него каждый запрос заново делает TLS
        self.requests_made = 0
        self.cache_hits = 0
        self._lock = threading.Lock()

    def _get(self, params: dict) -> requests.Response:
        for attempt in range(self.retries):
            try:
                return self.session.get(ITEMS_URL, params={**params, "key": self.key}, timeout=20)
            except (requests.ConnectionError, requests.Timeout) as e:
                if attempt == self.retries - 1:
                    # Без `from e`: исходное исключение содержит URL с ключом.
                    raise NetworkError(f"2ГИС недоступен: {type(e).__name__}") from None
                time.sleep(2 ** (attempt + 1))

    def items(self, **params) -> dict:
        params = {"locale": "ru_KZ", "page_size": PAGE_SIZE, "fields": FIELDS, **params}
        digest = hashlib.sha1(json.dumps(params, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        path = self.cache_dir / f"{digest}.json"
        if path.exists():
            with self._lock:
                self.cache_hits += 1
            return json.loads(path.read_text("utf-8"))

        with self._lock:
            if self.max_requests is not None and self.requests_made >= self.max_requests:
                raise QuotaExceeded(f"исчерпан бюджет запуска ({self.max_requests} запросов)")
            self.requests_made += 1

        resp = self._get(params)
        meta = resp.json().get("meta", {}) if resp.content else {}
        code = meta.get("code", resp.status_code)
        if code == 200:
            result = resp.json()["result"]
        elif code == 404:  # 2ГИС отвечает 404, когда ничего не нашлось
            result = {"total": 0, "items": []}
        elif code in (403, 429) or "limit" in json.dumps(meta).lower():
            raise QuotaExceeded(f"2ГИС отказал ({code}): {meta.get('error')}")
        else:
            raise RuntimeError(f"2ГИС вернул {code}: {meta.get('error')}")

        path.write_text(json.dumps(result, ensure_ascii=False), "utf-8")
        return result

    def search(self, q: str, lat: float, lon: float, radius: int,
               type: str | None = None, sort: str | None = None, max_pages: int = MAX_PAGE):
        """Отдаёт объекты постранично, пока не кончатся результаты или страницы."""
        extra = {k: v for k, v in {"type": type, "sort": sort}.items() if v}
        for page in range(1, min(max_pages, MAX_PAGE) + 1):
            res = self.items(q=q, point=f"{lon},{lat}", radius=radius, page=page, **extra)
            items = res.get("items", [])
            yield from items
            if len(items) < PAGE_SIZE or page * PAGE_SIZE >= res.get("total", 0):
                break

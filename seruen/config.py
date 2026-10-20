import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DGIS_API_KEY = os.getenv("DGIS_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
# gpt-oss-120b заметно лучше 20b в рекомендациях на русском; переопределяется через RAG_MODEL.
RAG_MODEL = os.getenv("RAG_MODEL", "openai/gpt-oss-120b")
# Разбор запроса проще — хватает 20b. Отдельная модель = отдельный лимит токенов в минуту у Groq.
INTENT_MODEL = os.getenv("GROQ_CHAT_MODEL", "openai/gpt-oss-20b")
STT_MODEL = os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo")

DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
POIS_PATH = DATA_DIR / "pois.json"

# Байтерек — центр города и точка по умолчанию.
DEFAULT_LAT = float(os.getenv("DEFAULT_LAT", "51.1283"))
DEFAULT_LON = float(os.getenv("DEFAULT_LON", "71.4305"))

# Границы сбора данных: левый и правый берег, Экспо, Mega Silk Way.
ASTANA_BBOX = {"lat_min": 51.07, "lat_max": 51.21, "lon_min": 71.33, "lon_max": 71.55}

# Ориентиры для быстрого выбора точки (координаты из 2ГИС).
LANDMARKS = {
    "Байтерек": (51.12829, 71.43045),
    "Хан Шатыр": (51.13213, 71.40283),
    "Mega Silk Way": (51.08935, 71.40544),
    "Экспо (Нур Алем)": (51.09118, 71.41761),
    "Вокзал Нурлы Жол": (51.11249, 71.53160),
    "Аэропорт": (51.02220, 71.46690),
}

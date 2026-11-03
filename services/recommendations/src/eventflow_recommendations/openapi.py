import json
from pathlib import Path

from .app import create_app
from .config import Config

if __name__ == "__main__":
    target = Path(__file__).resolve().parents[2] / "openapi.json"
    target.write_text(
        json.dumps(create_app(Config.read()).openapi(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

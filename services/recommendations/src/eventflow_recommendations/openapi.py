import json
import sys
from pathlib import Path

from .app import create_app
from .config import Config


def schema() -> dict[str, object]:
    config = Config(
        "postgresql://unused/schema",
        "http://127.0.0.1:4001",
        "http://127.0.0.1:18080/realms/schema",
        "s" * 32,
        "amqp://unused",
        "schema",
        Path("not-a-model"),
    )
    return create_app(config).openapi()


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[2] / "openapi.json"
    expected = schema()
    if "--check" in sys.argv:
        if json.loads(target.read_text(encoding="utf-8")) != expected:
            raise SystemExit("Recommendations OpenAPI is stale; regenerate it.")
        print("Recommendations OpenAPI matches runtime contracts.")
    else:
        target.write_text(
            json.dumps(expected, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

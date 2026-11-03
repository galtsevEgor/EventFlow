import logging

import uvicorn

from .app import create_app
from .config import Config
from .runtime import run
from .telemetry import Telemetry


def main() -> None:
    config = Config.read()
    signals = Telemetry("api")
    for name in ("httpx", "httpcore", "psycopg.pool", "opentelemetry.exporter"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(config, telemetry=signals),
            host="127.0.0.1",
            port=config.port,
            access_log=False,
            log_level="warning",
        )
    )
    try:
        run(server.serve())
    finally:
        signals.close()


if __name__ == "__main__":
    main()

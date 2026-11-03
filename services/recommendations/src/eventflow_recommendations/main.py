import logging

import uvicorn

from .app import create_app
from .config import Config
from .runtime import run


def main() -> None:
    config = Config.read()
    for name in ("httpx", "httpcore", "psycopg.pool"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(config),
            host="127.0.0.1",
            port=config.port,
            access_log=False,
            log_level="warning",
        )
    )
    run(server.serve())


if __name__ == "__main__":
    main()

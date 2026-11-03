import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Config:
    database_url: str
    catalog_url: str
    issuer: str
    client_secret: str
    amqp_url: str
    namespace: str
    model_path: Path
    port: int = 4008
    threads: int = 1

    @classmethod
    def read(cls, env: Mapping[str, str] | None = None) -> "Config":
        import re

        values = os.environ if env is None else env
        database = values.get("RECOMMENDATIONS_DATABASE_URL", "")
        if urlsplit(database).scheme not in ("postgresql", "postgres"):
            raise ValueError("Set RECOMMENDATIONS_DATABASE_URL")
        urls = {key: values.get(key, "") for key in ("CATALOG_URL", "OIDC_ISSUER")}
        for key, value in urls.items():
            url = urlsplit(value)
            if (
                url.scheme not in ("http", "https")
                or not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
                or (url.scheme == "http" and url.hostname not in ("127.0.0.1", "localhost"))
            ):
                raise ValueError(f"Invalid {key} transport")
        namespace = values.get("MESSAGE_NAMESPACE", "eventflow")
        if not re.fullmatch(r"[a-z0-9-]{1,80}", namespace):
            raise ValueError("Invalid message namespace")
        secret = values.get("RECOMMENDATIONS_CLIENT_SECRET", "")
        if len(secret) < 32:
            raise ValueError("Set RECOMMENDATIONS_CLIENT_SECRET")
        amqp = values.get("AMQP_URL", "")
        if urlsplit(amqp).scheme not in ("amqp", "amqps"):
            raise ValueError("Set AMQP_URL")
        threads = int(values.get("RECOMMENDATIONS_THREADS", "1"))
        port = int(values.get("PORT", "4008"))
        if not 1 <= threads <= 8 or not 1 <= port <= 65535:
            raise ValueError("Invalid runtime limits")
        return cls(
            database,
            urls["CATALOG_URL"].rstrip("/"),
            urls["OIDC_ISSUER"].rstrip("/"),
            secret,
            amqp,
            namespace,
            Path(
                values.get(
                    "RECOMMENDATIONS_MODEL_PATH",
                    "../../work/e21/models/paraphrase-multilingual-MiniLM-L12-v2",
                )
            ).resolve(),
            port,
            threads,
        )

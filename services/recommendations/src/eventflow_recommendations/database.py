import asyncio
import hashlib
from pathlib import Path
from typing import Any

from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

Row = dict[str, Any]
Pool = AsyncConnectionPool[AsyncConnection[Row]]


async def configure(connection: AsyncConnection[Row]) -> None:
    await register_vector_async(connection)


def pool(database_url: str) -> Pool:
    return AsyncConnectionPool(
        database_url,
        min_size=1,
        max_size=4,
        open=False,
        timeout=4,
        kwargs={"autocommit": True, "row_factory": dict_row},
        configure=configure,
    )


def read_migrations() -> list[tuple[str, str, str]]:
    root = Path(__file__).resolve().parents[2] / "migrations"
    result = []
    for path in sorted(root.glob("*.sql")):
        source = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
        result.append((path.name, source, hashlib.sha256(source.encode()).hexdigest()))
    return result


async def migrate(database_url: str) -> None:
    migrations = await asyncio.to_thread(read_migrations)
    async with await AsyncConnection.connect(database_url, autocommit=True) as connection:
        await connection.execute("SELECT pg_advisory_lock(21002101)")
        try:
            await connection.execute(
                "CREATE TABLE IF NOT EXISTS recommendation_migrations "
                "(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)"
            )
            for name, source, digest in migrations:
                cursor = await connection.execute(
                    "SELECT sha256 FROM recommendation_migrations WHERE name=%s", (name,)
                )
                previous = await cursor.fetchone()
                if previous:
                    if previous[0] != digest:
                        raise ValueError("An applied recommendations migration changed")
                    continue
                async with connection.transaction():
                    await connection.execute(source, prepare=False)
                    await connection.execute(
                        "INSERT INTO recommendation_migrations VALUES (%s,%s)", (name, digest)
                    )
        finally:
            await connection.execute("SELECT pg_advisory_unlock(21002101)")

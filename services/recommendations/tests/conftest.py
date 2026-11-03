import asyncio
import os
from collections.abc import AsyncIterator, Callable
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import pytest
from psycopg import AsyncConnection, sql

from eventflow_recommendations.database import Pool, migrate, pool


def pytest_asyncio_loop_factories() -> dict[str, Callable[[], asyncio.AbstractEventLoop]]:
    return {"selector": asyncio.SelectorEventLoop}


@pytest.fixture
async def projection_pool() -> AsyncIterator[Pool]:
    admin_url = os.environ.get("RECOMMENDATIONS_ADMIN_DATABASE_URL")
    application_url = os.environ.get("RECOMMENDATIONS_DATABASE_URL")
    if not admin_url or not application_url:
        raise RuntimeError("Run recommendations integration with local .env database settings")
    name = "eventflow_recommendations_test_" + uuid4().hex

    def database_url(value: str) -> str:
        parsed = urlsplit(value)
        return urlunsplit(parsed._replace(path="/" + name))

    async with await AsyncConnection.connect(admin_url, autocommit=True) as admin:
        await admin.execute(
            sql.SQL("CREATE DATABASE {} OWNER recommendations").format(sql.Identifier(name))
        )
        service_pool = pool(database_url(application_url))
        try:
            async with await AsyncConnection.connect(
                database_url(admin_url), autocommit=True
            ) as owner:
                await owner.execute("CREATE EXTENSION vector")
            await migrate(database_url(application_url))
            await service_pool.open()
            await service_pool.wait()
            yield service_pool
        finally:
            await service_pool.close()
            await admin.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name))
            )

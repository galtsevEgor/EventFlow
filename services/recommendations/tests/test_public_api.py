from __future__ import annotations

import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest

from eventflow_recommendations.app import create_app
from eventflow_recommendations.config import Config
from eventflow_recommendations.contracts import SourceDocument


class FakeCatalog:
    def __init__(self, documents=(), failure=None):
        self.documents = {document.id: document for document in documents}
        self.failure = failure
        self.hydrated = []
        self.upcoming_queries = []
        self.closed = False

    async def hydrate(self, ids):
        self.hydrated.append(ids)
        if self.failure:
            raise self.failure
        return [self.documents[id] for id in ids if id in self.documents]

    async def upcoming(self, filters, exclude):
        self.upcoming_queries.append((filters, exclude))
        return [document for id, document in self.documents.items() if id not in exclude]

    async def close(self):
        self.closed = True


def config():
    return Config(
        "postgresql://unused/test",
        "http://localhost:4001",
        "http://localhost:8080/realms/test",
        "s" * 32,
        "amqp://unused",
        "test",
        Path("not-a-model"),
    )


def document(id=None):
    starts = datetime.now(UTC) + timedelta(days=30)
    return SourceDocument.model_validate(
        {
            "id": str(id or uuid4()),
            "title": "Джазовый концерт",
            "description": "Concert de jazz",
            "city": "Chisinau",
            "address": "Test address",
            "timeZone": "Europe/Chisinau",
            "startsAt": starts.isoformat(),
            "endsAt": (starts + timedelta(hours=2)).isoformat(),
            "localDate": starts.date().isoformat(),
            "minPriceMinor": 1200,
            "currency": "EUR",
            "capacity": 100,
            "coverId": None,
        }
    )


def client(pool, catalog):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(
            app=create_app(config(), service_pool=pool, catalog=catalog),
            raise_app_exceptions=False,
        ),
        base_url="http://test",
    )


def assert_private(response):
    assert response.headers["cache-control"] == "no-store"
    UUID(response.headers["x-request-id"])
    if response.status_code >= 400:
        assert response.json()["requestId"] == response.headers["x-request-id"]
        assert response.json()["retryable"] == (
            response.status_code >= 500 or response.status_code == 429
        )


@pytest.mark.integration
class TestPublicApi:
    async def test_public_api_anonymous_warming_fallback_contract(self, projection_pool):
        source, candidate = document(), document()
        catalog = FakeCatalog([source, candidate])
        async with client(projection_pool, catalog) as http:
            response = await http.get(f"/api/v1/events/{source.id}/similar")
        assert response.status_code == 200
        assert_private(response)
        data = response.json()
        assert data["mode"] == "upcoming" and data["degraded"] is True
        assert len(data["items"]) == 1
        assert set(data["items"][0]) == {"event", "reason"}
        assert data["items"][0]["reason"] == "UPCOMING"
        event = data["items"][0]["event"]
        assert event == candidate.model_dump(mode="json", by_alias=True)
        assert event["timeZone"] == "Europe/Chisinau"
        assert event["localDate"] == candidate.local_date.isoformat()
        assert datetime.fromisoformat(event["startsAt"]).tzinfo is not None
        assert set(event) == {
            "id",
            "title",
            "description",
            "city",
            "address",
            "timeZone",
            "startsAt",
            "endsAt",
            "localDate",
            "minPriceMinor",
            "currency",
            "capacity",
            "coverId",
        }
        assert "score" not in response.text and "confidence" not in response.text
        assert catalog.hydrated == [[source.id]]
        assert not catalog.closed
        async with projection_pool.connection() as connection:
            assert await (await connection.execute("SELECT 1 AS alive")).fetchone()

    async def test_public_api_filter_aliases_parsed_and_forwarded(self, projection_pool):
        source, candidate = document(), document()
        catalog = FakeCatalog([source, candidate])
        query = {
            "city": "  Chisinau  ",
            "from": candidate.local_date.isoformat(),
            "to": candidate.local_date.isoformat(),
            "minPriceMinor": "1200",
            "maxPriceMinor": "1300",
            "limit": "1",
        }
        async with client(projection_pool, catalog) as http:
            response = await http.get(f"/api/v1/events/{source.id}/similar", params=query)
        assert response.status_code == 200, response.text
        assert_private(response)
        filters, excluded = catalog.upcoming_queries[0]
        assert filters.city == "Chisinau"
        assert filters.from_date == filters.to_date == candidate.local_date
        assert filters.min_price_minor == 1200 and filters.max_price_minor == 1300
        assert filters.limit == 1 and excluded == [source.id]
        assert len(response.json()["items"]) == 1

    async def test_public_api_missing_or_unpublished_source404(self, projection_pool):
        id = uuid4()
        catalog = FakeCatalog()
        async with client(projection_pool, catalog) as http:
            response = await http.get(f"/api/v1/events/{id}/similar")
        assert response.status_code == 404
        assert_private(response)
        assert response.json() == {
            "code": "NOT_FOUND",
            "message": "Событие не найдено.",
            "requestId": response.headers["x-request-id"],
            "retryable": False,
        }
        assert catalog.hydrated == [[id]] and not catalog.upcoming_queries

    @pytest.mark.parametrize(
        "path,query",
        [
            ("not-a-uuid", {}),
            (str(uuid4()), {"from": "2027-02-02", "to": "2027-01-01"}),
            (str(uuid4()), {"minPriceMinor": "2000", "maxPriceMinor": "1000"}),
            (str(uuid4()), {"limit": "13"}),
            (str(uuid4()), {"limit": "0"}),
            (str(uuid4()), {"unknown": "private-query-sentinel"}),
            (str(uuid4()), {"from": "not-a-date"}),
            (str(uuid4()), {"minPriceMinor": "-1"}),
        ],
    )
    async def test_public_api_invalid_query422_without_source_call(
        self, projection_pool, path, query
    ):
        catalog = FakeCatalog()
        async with client(projection_pool, catalog) as http:
            response = await http.get(f"/api/v1/events/{path}/similar", params=query)
        assert response.status_code == 422, response.text
        assert_private(response)
        assert response.json() == {
            "code": "VALIDATION_FAILED",
            "message": "Проверьте параметры подборки.",
            "requestId": response.headers["x-request-id"],
            "retryable": False,
        }
        assert "private-query-sentinel" not in response.text
        assert not catalog.hydrated and not catalog.upcoming_queries

    async def test_public_api_catalog_failure503_sanitizes_private_diagnostic(
        self, projection_pool
    ):
        diagnostic = (
            "Bearer private-token postgresql://user:password@internal/db private-diagnostic"
        )
        catalog = FakeCatalog(failure=RuntimeError(diagnostic))
        async with client(projection_pool, catalog) as http:
            response = await http.get(f"/api/v1/events/{uuid4()}/similar")
        assert response.status_code == 503
        assert response.json() == {
            "code": "RECOMMENDATIONS_UNAVAILABLE",
            "message": "Подборка временно недоступна.",
            "requestId": response.headers["x-request-id"],
            "retryable": True,
        }
        assert all(
            secret not in response.text
            for secret in [
                "private-token",
                "password",
                "internal",
                "postgresql",
                "private-diagnostic",
            ]
        )
        assert_private(response)

    async def test_public_api_database_failure503_is_sanitized(self, projection_pool):
        source = document()
        async with projection_pool.connection() as connection:
            await connection.execute("DROP TABLE recommendation_projection")
        catalog = FakeCatalog([source])
        async with client(projection_pool, catalog) as http:
            response = await http.get(f"/api/v1/events/{source.id}/similar")
        assert response.status_code == 503
        assert response.json() == {
            "code": "RECOMMENDATIONS_UNAVAILABLE",
            "message": "Подборка временно недоступна.",
            "requestId": response.headers["x-request-id"],
            "retryable": True,
        }
        assert "recommendation_projection" not in response.text
        assert "SELECT" not in response.text and "Traceback" not in response.text
        assert_private(response)


def test_public_api_import_avoids_ml_weights_and_torch():
    code = (
        "import sys;sys.path.insert(0,sys.argv[1]);import eventflow_recommendations.app;"
        "assert 'torch' not in sys.modules;assert 'sentence_transformers' not in sys.modules;"
        "assert 'eventflow_recommendations.embeddings' not in sys.modules"
    )
    result = subprocess.run(
        [sys.executable, "-c", code, str(Path(__file__).resolve().parents[1] / "src")],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr

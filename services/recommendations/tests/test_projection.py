from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from psycopg import OperationalError

from eventflow_recommendations.catalog import CatalogClient, InvalidSource, SourceChanged
from eventflow_recommendations.config import Config
from eventflow_recommendations.contracts import SourceChange, SourceDocument, SourcePage
from eventflow_recommendations.projection import Projection
from eventflow_recommendations.worker import poll, validate_notification


def document(event_id: UUID, title: str = "Jazz concert") -> SourceDocument:
    return SourceDocument.model_validate(
        {
            "id": str(event_id),
            "title": title,
            "description": "Live music and piano",
            "city": "Chisinau",
            "address": "Test1",
            "timeZone": "Europe/Chisinau",
            "startsAt": "2027-01-01T16:00:00Z",
            "endsAt": "2027-01-01T18:00:00Z",
            "localDate": "2027-01-01",
            "minPriceMinor": 1000,
            "currency": "EUR",
            "capacity": 100,
            "coverId": None,
        }
    )


def change(position: int, event_id: UUID, title: str | None = "Jazz concert") -> SourceChange:
    return SourceChange(
        position=position, eventId=event_id, document=document(event_id, title) if title else None
    )


class FakeFeed:
    def __init__(self, changes: list[SourceChange]) -> None:
        self.changes = changes
        self.reconciliations = 0
        self.calls: list[tuple[int, int | None]] = []
        self.failure: Exception | None = None

    async def reconcile(self) -> None:
        self.reconciliations += 1

    async def read(self, after: int, through: int | None = None) -> SourcePage:
        self.calls.append((after, through))
        if self.failure:
            raise self.failure
        high = (
            through if through is not None else max((c.position for c in self.changes), default=0)
        )
        changes = [c for c in self.changes if after < c.position <= high][:100]
        return SourcePage(
            changes=changes, through=high, next=changes[-1].position if changes else after
        )


class FakeEmbedder:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.failure = False
        self.started = threading.Event()
        self.release: threading.Event | None = None

    def encode(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(texts)
        self.started.set()
        if self.release is not None and not self.release.wait(timeout=10):
            raise RuntimeError("Test embedding deadline")
        if self.failure:
            raise RuntimeError("Synthetic model failure")
        return [[1.0] + [0.0] * 383 for _ in texts]


async def state(pool):
    async with pool.connection() as conn:
        return await (await conn.execute("SELECT * FROM recommendation_projection")).fetchone()


async def docs(pool):
    async with pool.connection() as conn:
        return await (
            await conn.execute("SELECT * FROM recommendation_documents ORDER BY source_position")
        ).fetchall()


@pytest.mark.integration
class TestProjectionDatabase:
    async def test_pages_latest_collapse_frozen_horizon_and_activation(self, projection_pool):
        ids = [uuid4() for _ in range(101)]
        feed = FakeFeed([change(i + 1, event) for i, event in enumerate(ids)])
        embedder = FakeEmbedder()
        projection = Projection(projection_pool, feed, embedder, "model1")
        assert not await projection.sync_once()
        first = await state(projection_pool)
        assert first["cursor"] == 100 and first["through"] == 101
        assert first["active_generation"] is None
        feed.changes.append(change(102, ids[0], "New title"))
        assert await projection.sync_once()
        second = await state(projection_pool)
        assert (
            second["cursor"] == 101 and second["active_generation"] == second["building_generation"]
        )
        assert feed.calls == [(0, None), (100, 101)]
        assert await projection.sync_once()
        assert (await state(projection_pool))["cursor"] == 102
        assert len(await docs(projection_pool)) == 101
        assert (await docs(projection_pool))[-1]["document"]["title"] == "New title"
        assert len(embedder.calls[1]) == 12  # One interest batch per generation.

    async def test_collapse_tombstone_monotonic_positions(self, projection_pool):
        event = uuid4()
        feed = FakeFeed([change(1, event), change(2, event, "New concert"), change(3, event, None)])
        embedder = FakeEmbedder()
        projection = Projection(projection_pool, feed, embedder, "model1")
        assert await projection.sync_once()
        saved = await docs(projection_pool)
        assert len(saved) == 1 and saved[0]["source_position"] == 3
        assert saved[0]["document"] is None and saved[0]["embedding"] is None
        assert len(embedder.calls) == 1 and len(embedder.calls[0]) == 12
        feed.changes.append(change(4, event, "Published again"))
        assert await projection.sync_once()
        assert (await docs(projection_pool))[0]["source_position"] == 4
        assert len(await docs(projection_pool)) == 1

    async def test_model_failure_then_retry_and_sql_rollback(self, projection_pool):
        event = uuid4()
        feed, embedder = FakeFeed([change(1, event)]), FakeEmbedder()
        projection = Projection(projection_pool, feed, embedder, "model1")
        embedder.failure = True
        with pytest.raises(RuntimeError, match="Synthetic"):
            await projection.sync_once()
        assert (await state(projection_pool))["cursor"] == 0
        assert not await docs(projection_pool)
        embedder.failure = False
        async with projection_pool.connection() as conn:
            await conn.execute(
                "CREATE FUNCTION reject_document() RETURNS trigger LANGUAGE plpgsql "
                "AS $$ BEGIN RAISE EXCEPTION 'synthetic transaction failure'; END $$"
            )
            await conn.execute(
                "CREATE TRIGGER reject_document BEFORE INSERT ON "
                "recommendation_documents FOR EACH ROW EXECUTE FUNCTION reject_document()"
            )
        with pytest.raises(Exception, match="synthetic transaction failure"):
            await projection.sync_once()
        assert (await state(projection_pool))["cursor"] == 0
        assert (await state(projection_pool))["active_generation"] is None
        assert not await docs(projection_pool)
        async with projection_pool.connection() as conn:
            await conn.execute("DROP TRIGGER reject_document ON recommendation_documents")
        assert await projection.sync_once()
        assert (await state(projection_pool))["cursor"] == 1

    async def test_rebuild_model_change_keeps_old_active_until_complete(self, projection_pool):
        feed, embedder = FakeFeed([]), FakeEmbedder()
        initial = Projection(projection_pool, feed, embedder, "model1")
        assert await initial.sync_once()
        old = (await state(projection_pool))["active_generation"]
        feed.changes = [change(i + 1, uuid4()) for i in range(101)]
        newer = Projection(projection_pool, feed, embedder, "model2")
        assert not await newer.sync_once()
        partial = await state(projection_pool)
        assert partial["active_generation"] == old and partial["active_model"] == "model1"
        assert partial["building_generation"] != old
        assert await newer.sync_once()
        complete = await state(projection_pool)
        assert complete["active_generation"] != old and complete["active_model"] == "model2"
        generation = await newer.rebuild()
        rebuilt = await state(projection_pool)
        assert rebuilt["active_generation"] == complete["active_generation"]
        assert rebuilt["building_generation"] == generation and rebuilt["cursor"] == 0
        assert not await newer.sync_once()
        assert await newer.sync_once()
        assert (await state(projection_pool))["active_generation"] == generation
        async with projection_pool.connection() as conn:
            rows = await (
                await conn.execute(
                    "SELECT DISTINCT generation FROM recommendation_interest_vectors"
                )
            ).fetchall()
            assert rows == [{"generation": generation}]

    async def test_source409_and_invalid_feed_fail_closed(self, projection_pool):
        feed, embedder = FakeFeed([change(1, uuid4())]), FakeEmbedder()
        projection = Projection(projection_pool, feed, embedder, "model1")
        assert await projection.sync_once()
        old = await state(projection_pool)
        feed.failure = SourceChanged()
        assert not await projection.sync_once()
        reset = await state(projection_pool)
        assert reset["active_generation"] == old["active_generation"]
        assert reset["building_generation"] != old["building_generation"] and reset["cursor"] == 0
        feed.failure = None
        feed.changes = [change(2, uuid4()), change(1, uuid4())]
        with pytest.raises(InvalidSource):
            await projection.sync_once()
        assert (await state(projection_pool))["cursor"] == 0
        assert len(await docs(projection_pool)) == 1

    async def test_session_lease_no_transaction_during_compute_and_cas_fence(self, projection_pool):
        feed, embedder = FakeFeed([change(1, uuid4())]), FakeEmbedder()
        embedder.release = threading.Event()
        projection = Projection(projection_pool, feed, embedder, "model1")
        task = asyncio.create_task(projection.sync_once())
        assert await asyncio.to_thread(embedder.started.wait, 5)
        try:
            async with projection_pool.connection() as conn:
                activity = await (
                    await conn.execute(
                        "SELECT a.state FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid "
                        "WHERE l.locktype='advisory' AND l.objid=21002100 AND l.granted "
                        "AND l.database=(SELECT oid FROM pg_database "
                        "WHERE datname=current_database())"
                    )
                ).fetchone()
                assert activity["state"] == "idle"
                assert not (
                    await (
                        await conn.execute("SELECT pg_try_advisory_lock(21002100) AS held")
                    ).fetchone()
                )["held"]
                generation = uuid4()
                await conn.execute(
                    "UPDATE recommendation_projection SET building_generation=%s", (generation,)
                )
            assert not await Projection(projection_pool, feed, embedder, "model1").sync_once()
            with pytest.raises(RuntimeError, match="busy"):
                await projection.rebuild()
        finally:
            embedder.release.set()
        assert not await task
        assert (await state(projection_pool))["building_generation"] == generation
        assert (await state(projection_pool))["cursor"] == 0
        assert not await docs(projection_pool)
        assert await projection.sync_once()

    async def test_rebuild_does_not_need_model_files_or_embedding_runtime(self, projection_pool):
        projection = Projection(projection_pool, FakeFeed([]), None, "model1")
        generation = await projection.rebuild()
        checkpoint = await state(projection_pool)
        assert checkpoint["building_generation"] == generation
        assert checkpoint["active_generation"] is None and checkpoint["cursor"] == 0
        with pytest.raises(RuntimeError, match="embedding runtime"):
            await projection.sync_once()

    async def test_lost_session_cannot_commit_computed_batch(self, projection_pool):
        feed, embedder = FakeFeed([change(1, uuid4())]), FakeEmbedder()
        embedder.release = threading.Event()
        projection = Projection(projection_pool, feed, embedder, "model1")
        task = asyncio.create_task(projection.sync_once())
        assert await asyncio.to_thread(embedder.started.wait, 5)
        try:
            async with projection_pool.connection() as conn:
                await conn.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_locks "
                    "WHERE locktype='advisory' AND objid=21002100 AND granted "
                    "AND database=(SELECT oid FROM pg_database WHERE datname=current_database())"
                )
        finally:
            embedder.release.set()
        with pytest.raises(OperationalError):
            await task
        assert (await state(projection_pool))["cursor"] == 0
        assert not await docs(projection_pool)
        assert await projection.sync_once()


def notification(event: UUID | None = None, position: int = 1):
    event = event or uuid4()
    return {
        "eventId": str(uuid4()),
        "eventType": "SearchDocumentChanged.v1",
        "schemaVersion": 1,
        "aggregateId": str(event),
        "aggregateVersion": position,
        "occurredAt": "2026-11-10T12:00:00Z",
        "correlationId": str(uuid4()),
        "producer": "catalog",
        "data": change(position, event).model_dump(mode="json", by_alias=True),
    }


def test_duplicate_stale_notifications_are_only_validated_hints():
    message = notification()
    assert validate_notification(json.dumps(message).encode()).data.position == 1
    assert validate_notification(json.dumps(message).encode()).data.position == 1
    newer = notification(position=4)
    assert validate_notification(json.dumps(newer).encode()).data.position == 4
    assert validate_notification(json.dumps(message).encode()).data.position == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("producer", "booking"),
        ("aggregateVersion", 2),
        ("aggregateId", str(uuid4())),
        ("schemaVersion", 2),
    ],
)
def test_invalid_notifications_rejected(field, value):
    message = notification()
    message[field] = value
    with pytest.raises(ValueError):
        validate_notification(json.dumps(message).encode())


def config() -> Config:
    return Config(
        "postgresql://unused/test",
        "http://localhost:4001",
        "http://localhost:8080/realms/test",
        "s" * 32,
        "amqp://unused",
        "test",
        Path("unused"),
    )


async def test_catalog_singleflight_pin_validation_and_current_hydration():
    event = uuid4()
    calls = []

    async def transport(request):
        calls.append(request)
        assert not request.extensions.get("follow_redirects", False)
        if request.url.path.endswith("/token"):
            await asyncio.sleep(0.01)
            return httpx.Response(
                200, json={"access_token": "secret", "expires_in": 300, "token_type": "Bearer"}
            )
        assert request.headers["authorization"] == "Bearer secret"
        if request.url.path.endswith("hydrate"):
            return httpx.Response(
                200, json={"events": [document(event).model_dump(mode="json", by_alias=True)]}
            )
        return httpx.Response(
            200,
            json={
                "changes": [change(1, event).model_dump(mode="json", by_alias=True)],
                "through": 1,
                "next": 1,
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        feed = CatalogClient(config(), client)
        pages = await asyncio.gather(feed.read(0), feed.read(0))
        assert pages[0].next == pages[1].next == 1
        assert sum(request.url.path.endswith("/token") for request in calls) == 1
        assert (await feed.hydrate([event]))[0].id == event
        await feed.close()
        assert not client.is_closed


@pytest.mark.parametrize(
    "result",
    [
        {"changes": [], "through": 1, "next": 0},
        {"changes": [], "through": 0, "next": 1},
        {"changes": [], "through": 2, "next": 0},
        {"changes": [], "through": 0, "next": 0, "unknown": True},
    ],
)
async def test_catalog_rejects_malformed_feed(result):
    def transport(request):
        if request.url.path.endswith("/token"):
            return httpx.Response(
                200, json={"access_token": "x", "expires_in": 300, "token_type": "Bearer"}
            )
        return httpx.Response(200, json=result)

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        with pytest.raises(ValueError):
            await CatalogClient(config(), client).read(0, 0)


async def test_catalog409_and_redirect_fail_without_following():
    target_calls = []
    status = 409

    def transport(request):
        target_calls.append(request.url.path)
        if request.url.path.endswith("/token"):
            return httpx.Response(
                200, json={"access_token": "x", "expires_in": 300, "token_type": "Bearer"}
            )
        return httpx.Response(status, headers={"Location": "http://other.invalid/secret"})

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(transport), follow_redirects=True
    ) as client:
        feed = CatalogClient(config(), client)
        with pytest.raises(SourceChanged):
            await feed.read(0)
        status = 302
        with pytest.raises(RuntimeError):
            await feed.read(0)
    assert len(target_calls) == 3


async def test_poll_wakes_and_continues_after_failure_without_mq():
    stop, wake = asyncio.Event(), asyncio.Event()
    calls = 0

    class FakeProjection:
        async def sync_once(self):
            nonlocal calls
            calls += 1
            if calls == 1:
                wake.set()
                raise RuntimeError("Synthetic")
            stop.set()
            return True

    await asyncio.wait_for(poll(FakeProjection(), wake, stop), timeout=1)
    assert calls == 2


@pytest.mark.parametrize(
    "field,value",
    [
        ("schemaVersion", True),
        ("schemaVersion", 1.0),
        ("aggregateVersion", True),
        ("occurredAt", 1794312000),
        ("occurredAt", "not-a-timestamp"),
    ],
)
def test_notifications_reject_coercions(field, value):
    message = notification()
    message[field] = value
    with pytest.raises(ValueError):
        validate_notification(json.dumps(message).encode())


async def test_catalog_reconcile_and_hydration_reject_bad_identity_or_order():
    event = uuid4()
    mode = "reconcile"
    calls = 0

    def transport(request):
        nonlocal calls
        if request.url.path.endswith("/token"):
            return httpx.Response(
                200, json={"access_token": "x", "expires_in": 300, "token_type": "Bearer"}
            )
        calls += 1
        if mode == "reconcile":
            return httpx.Response(200, json={"next": str(event)})
        return httpx.Response(
            200, json={"events": [document(uuid4()).model_dump(mode="json", by_alias=True)]}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        feed = CatalogClient(config(), client)
        with pytest.raises(InvalidSource, match="reconcile"):
            await feed.reconcile()
        assert calls == 2
        mode = "hydrate"
        with pytest.raises(InvalidSource, match="identity"):
            await feed.hydrate([event])


async def test_consumer_quorum_contract_valid_ack_invalid_reject_and_close(monkeypatch):
    from eventflow_recommendations import worker

    stop, wake = asyncio.Event(), asyncio.Event()
    actions = []

    class Message:
        def __init__(self, body):
            self.body = body

        async def ack(self):
            actions.append("ack")

        async def reject(self, *, requeue):
            assert not requeue
            actions.append("reject")

    class Queue:
        async def bind(self, exchange, *, routing_key):
            assert routing_key == "SearchDocumentChanged.v1"

        async def consume(self, callback):
            await callback(Message(b"invalid"))
            assert not wake.is_set()
            await callback(Message(json.dumps(notification()).encode()))
            assert wake.is_set()
            stop.set()
            return "consumer1"

        async def cancel(self, tag):
            assert tag == "consumer1"
            actions.append("cancel")

    class Connection:
        async def channel(self):
            return self

        async def set_qos(self, *, prefetch_count):
            assert prefetch_count == 10

        async def declare_exchange(self, name, kind, *, durable):
            assert name == "test.events" and durable
            return self

        async def declare_queue(self, name, *, durable, arguments):
            assert name == "test.recommendations" and durable
            assert arguments == {
                "x-queue-type": "quorum",
                "x-max-length": 10000,
                "x-overflow": "reject-publish",
            }
            return Queue()

        async def close(self):
            actions.append("close")

    async def connect(*args, **kwargs):
        return Connection()

    monkeypatch.setattr(worker.aio_pika, "connect_robust", connect)
    await worker.consume_notifications(config(), wake, stop)
    assert actions == ["reject", "ack", "cancel", "close"]

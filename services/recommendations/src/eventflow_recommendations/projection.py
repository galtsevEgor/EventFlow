"""Fenced, generation-based local recommendation projection."""

from __future__ import annotations

import asyncio
import math
from typing import Protocol
from uuid import UUID, uuid4

from pgvector import Vector
from psycopg.types.json import Jsonb

from .catalog import SourceChanged, validate_page
from .contracts import SourcePage
from .database import Pool
from .interests import INTERESTS

LOCK = 21002100


class Feed(Protocol):
    async def read(self, after: int, through: int | None = None) -> SourcePage: ...
    async def reconcile(self) -> None: ...


class Embedder(Protocol):
    def encode(self, texts: list[str]) -> list[list[float]]: ...


def checked_vectors(vectors: list[list[float]], count: int) -> list[Vector]:
    if len(vectors) != count:
        raise ValueError("Invalid embedding count")
    result = []
    for vector in vectors:
        if len(vector) != 384 or not all(math.isfinite(value) for value in vector):
            raise ValueError("Invalid embedding vector")
        norm = sum(value * value for value in vector)
        if abs(norm - 1) > 1e-5:
            raise ValueError("Embedding vector must be normalized")
        result.append(Vector(vector))
    return result


class Projection:
    def __init__(
        self, pool: Pool, feed: Feed, embedder: Embedder | None, model_version: str
    ) -> None:
        self.pool, self.feed, self.embedder, self.model_version = (
            pool,
            feed,
            embedder,
            model_version,
        )
        self._reconciled: UUID | None = None

    async def rebuild(self) -> UUID:
        async with self.pool.connection() as conn:
            cursor = await conn.execute("SELECT pg_try_advisory_lock(%s) AS held", (LOCK,))
            locked = await cursor.fetchone()
            if not locked or not locked["held"]:
                raise RuntimeError("Projection is busy; retry rebuild")
            try:
                generation = uuid4()
                await conn.execute(
                    "INSERT INTO recommendation_projection "
                    "(id,building_generation,building_model) VALUES (1,%s,%s) "
                    "ON CONFLICT(id) DO UPDATE SET "
                    "building_generation=EXCLUDED.building_generation,"
                    "building_model=EXCLUDED.building_model,cursor=0,through=0,heartbeat=NULL,"
                    "updated_at=clock_timestamp()",
                    (generation, self.model_version),
                )
                self._reconciled = None
                return generation
            finally:
                await conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK,))

    async def sync_once(self) -> bool:
        if self.embedder is None:
            raise RuntimeError("An embedding runtime is required for projection sync")
        async with self.pool.connection() as conn:
            cursor = await conn.execute("SELECT pg_try_advisory_lock(%s) AS held", (LOCK,))
            locked = await cursor.fetchone()
            if not locked or not locked["held"]:
                return False
            try:
                await conn.execute(
                    "INSERT INTO recommendation_projection "
                    "(id,building_generation,building_model) VALUES (1,%s,%s) "
                    "ON CONFLICT DO NOTHING",
                    (uuid4(), self.model_version),
                )
                await conn.execute(
                    "UPDATE recommendation_projection SET building_generation=%s,building_model=%s,"
                    "cursor=0,through=0,heartbeat=NULL,updated_at=clock_timestamp() "
                    "WHERE id=1 AND building_model<>%s",
                    (uuid4(), self.model_version, self.model_version),
                )
                cursor = await conn.execute("SELECT * FROM recommendation_projection WHERE id=1")
                state = await cursor.fetchone()
                assert state is not None
                generation = state["building_generation"]
                if self._reconciled != generation:
                    if state["cursor"] == 0:
                        await self.feed.reconcile()
                    self._reconciled = generation
                horizon = state["through"] if state["through"] > state["cursor"] else None
                try:
                    page = await self.feed.read(state["cursor"], horizon)
                except SourceChanged:
                    await conn.execute(
                        "UPDATE recommendation_projection SET building_generation=%s,"
                        "building_model=%s,cursor=0,through=0,heartbeat=NULL "
                        "WHERE id=1 AND building_generation=%s AND cursor=%s",
                        (uuid4(), self.model_version, generation, state["cursor"]),
                    )
                    self._reconciled = None
                    return False
                validate_page(page, state["cursor"], horizon)
                latest = {change.event_id: change for change in page.changes}
                documents = {
                    change.event_id: change.document
                    for change in latest.values()
                    if change.document is not None
                }
                vectors = (
                    checked_vectors(
                        await asyncio.to_thread(
                            self.embedder.encode,
                            [
                                f"{document.title}\n{document.description}"
                                for document in documents.values()
                            ],
                        ),
                        len(documents),
                    )
                    if documents
                    else []
                )
                by_id = {
                    event_id: vector for event_id, vector in zip(documents, vectors, strict=True)
                }
                cursor = await conn.execute(
                    "SELECT count(*) AS count FROM recommendation_interest_vectors "
                    "WHERE generation=%s",
                    (generation,),
                )
                interests_present = await cursor.fetchone()
                interest_vectors = None
                if not interests_present or interests_present["count"] != len(INTERESTS):
                    interest_vectors = checked_vectors(
                        await asyncio.to_thread(
                            self.embedder.encode, [interest.description for interest in INTERESTS]
                        ),
                        len(INTERESTS),
                    )
                complete = page.next == page.through
                # Session ownership persists across I/O/model; the SQL transaction starts here.
                async with conn.transaction():
                    cursor = await conn.execute(
                        "UPDATE recommendation_projection SET cursor=%s,through=%s,"
                        "heartbeat=clock_timestamp(),updated_at=clock_timestamp(),"
                        "active_generation=CASE WHEN %s THEN building_generation "
                        "ELSE active_generation END,"
                        "active_model=CASE WHEN %s THEN building_model ELSE active_model END "
                        "WHERE id=1 AND building_generation=%s AND building_model=%s AND cursor=%s "
                        "RETURNING id",
                        (
                            page.next,
                            page.through,
                            complete,
                            complete,
                            generation,
                            self.model_version,
                            state["cursor"],
                        ),
                    )
                    if await cursor.fetchone() is None:
                        return False
                    for change in latest.values():
                        await conn.execute(
                            "INSERT INTO recommendation_documents "
                            "(generation,event_id,source_position,document,embedding) "
                            "VALUES (%s,%s,%s,%s,%s) ON CONFLICT(generation,event_id) DO UPDATE "
                            "SET source_position=EXCLUDED.source_position,"
                            "document=EXCLUDED.document,"
                            "embedding=EXCLUDED.embedding WHERE "
                            "recommendation_documents.source_position<EXCLUDED.source_position",
                            (
                                generation,
                                change.event_id,
                                change.position,
                                Jsonb(change.document.model_dump(mode="json", by_alias=True))
                                if change.document
                                else None,
                                by_id.get(change.event_id),
                            ),
                        )
                    if interest_vectors is not None:
                        for interest, vector in zip(INTERESTS, interest_vectors, strict=True):
                            await conn.execute(
                                "INSERT INTO recommendation_interest_vectors VALUES (%s,%s,%s) "
                                "ON CONFLICT(generation,interest_id) DO UPDATE "
                                "SET embedding=EXCLUDED.embedding",
                                (generation, interest.id, vector),
                            )
                    if complete:
                        await conn.execute(
                            "DELETE FROM recommendation_documents WHERE generation<>%s",
                            (generation,),
                        )
                        await conn.execute(
                            "DELETE FROM recommendation_interest_vectors WHERE generation<>%s",
                            (generation,),
                        )
                return complete
            finally:
                if not conn.closed:
                    await conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK,))

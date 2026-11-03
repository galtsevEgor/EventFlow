"""Prepared-vector ranking with authoritative Catalog hydration outside SQL transactions."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID

from pgvector import Vector
from psycopg import AsyncConnection

from .contracts import (
    RecommendationFilters,
    RecommendationItem,
    RecommendationPage,
    SourceDocument,
)
from .database import Pool, Row
from .errors import ApiError

CANDIDATE_LIMIT = 60


class Catalog(Protocol):
    async def hydrate(self, ids: list[UUID]) -> list[SourceDocument]: ...
    async def upcoming(
        self, filters: RecommendationFilters, exclude: list[UUID]
    ) -> list[SourceDocument]: ...


def matches(document: SourceDocument, filters: RecommendationFilters, now: datetime) -> bool:
    return (
        document.starts_at > now
        and (not filters.city or document.city.lower() == filters.city.lower())
        and (filters.from_date is None or document.local_date >= filters.from_date)
        and (filters.to_date is None or document.local_date <= filters.to_date)
        and (filters.min_price_minor is None or document.min_price_minor >= filters.min_price_minor)
        and (filters.max_price_minor is None or document.min_price_minor <= filters.max_price_minor)
    )


def prepared_vector(values: object) -> Vector | None:
    """Use only valid prepared vectors; missing/corrupt state never triggers inference."""
    if values is None:
        return None
    try:
        if isinstance(values, Vector):
            vector = values
        elif isinstance(values, list):
            vector = Vector(values)
        else:
            return None
        numbers = vector.to_list()
        if len(numbers) != 384 or not all(math.isfinite(value) for value in numbers):
            return None
        if abs(sum(value * value for value in numbers) - 1) > 1e-4:
            return None
        return vector
    except (TypeError, ValueError):
        return None


async def nearest_candidates(
    connection: AsyncConnection[Row],
    generation: UUID,
    vector: Vector,
    filters: RecommendationFilters,
    exclude: list[UUID],
    now: datetime,
) -> list[UUID]:
    """Reuse for personal ranking; callers own a repeatable-read generation snapshot."""
    await connection.execute("SET LOCAL hnsw.iterative_scan = strict_order")
    await connection.execute("SET LOCAL hnsw.ef_search = 100")
    where = (
        "generation=%s AND embedding IS NOT NULL AND document IS NOT NULL "
        "AND NOT (event_id=ANY(%s::uuid[])) "
        "AND (document->>'startsAt')::timestamptz>%s "
        "AND (%s::text='' OR lower(document->>'city')=lower(%s)) "
        "AND (%s::date IS NULL OR (document->>'localDate')::date>=%s::date) "
        "AND (%s::date IS NULL OR (document->>'localDate')::date<=%s::date) "
        "AND (%s::integer IS NULL OR (document->>'minPriceMinor')::integer>=%s::integer) "
        "AND (%s::integer IS NULL OR (document->>'minPriceMinor')::integer<=%s::integer)"
    )
    parameters = (
        generation,
        exclude,
        now,
        filters.city,
        filters.city,
        filters.from_date,
        filters.from_date,
        filters.to_date,
        filters.to_date,
        filters.min_price_minor,
        filters.min_price_minor,
        filters.max_price_minor,
        filters.max_price_minor,
    )
    cursor = await connection.execute(
        "WITH nearest AS MATERIALIZED (SELECT event_id,embedding<=>%s AS distance "
        "FROM recommendation_documents WHERE " + where + " ORDER BY embedding<=>%s LIMIT %s) "
        "SELECT event_id FROM nearest ORDER BY distance,event_id",
        (vector, *parameters, vector, CANDIDATE_LIMIT),
    )
    rows = await cursor.fetchall()
    # Restrictive filters can exhaust ANN's scan budget. Recover exact bounded candidates.
    if len(rows) < CANDIDATE_LIMIT:
        await connection.execute("SET LOCAL enable_indexscan = off")
        cursor = await connection.execute(
            "SELECT event_id FROM recommendation_documents WHERE "
            + where
            + " ORDER BY embedding<=>%s,event_id LIMIT %s",
            (*parameters, vector, CANDIDATE_LIMIT),
        )
        rows = await cursor.fetchall()
        await connection.execute("SET LOCAL enable_indexscan = on")
    return [row["event_id"] for row in rows]


class Recommendations:
    def __init__(self, pool: Pool, catalog: Catalog) -> None:
        self.pool, self.catalog = pool, catalog

    async def similar(self, event_id: UUID, filters: RecommendationFilters) -> RecommendationPage:
        current = await self.catalog.hydrate([event_id])
        source = next((document for document in current if document.id == event_id), None)
        if source is None or source.starts_at <= datetime.now(UTC):
            raise ApiError(
                404,
                "NOT_FOUND",
                "Событие не найдено.",
            )
        effective = filters.model_copy(update={"city": filters.city or source.city})
        async with self.pool.connection() as connection, connection.transaction():
            await connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            cursor = await connection.execute(
                "SELECT p.active_generation,p.active_model,d.embedding "
                "FROM recommendation_projection p LEFT JOIN recommendation_documents d "
                "ON d.generation=p.active_generation AND d.event_id=%s AND d.document IS NOT NULL "
                "WHERE p.id=1",
                (event_id,),
            )
            state = await cursor.fetchone()
            vector = prepared_vector(state["embedding"]) if state else None
            candidates = None
            if (
                state
                and state["active_generation"] is not None
                and state["active_model"] is not None
                and vector is not None
            ):
                candidates = await nearest_candidates(
                    connection,
                    state["active_generation"],
                    vector,
                    effective,
                    [event_id],
                    datetime.now(UTC),
                )
        if candidates is None:
            return await self._upcoming(effective, [event_id])
        current_candidates = await self.catalog.hydrate(candidates) if candidates else []
        by_id = {document.id: document for document in current_candidates}
        now = datetime.now(UTC)
        items = [
            RecommendationItem(event=by_id[candidate], reason="SIMILAR")
            for candidate in candidates
            if candidate in by_id and matches(by_id[candidate], effective, now)
        ][: effective.limit]
        return RecommendationPage(items=items, mode="similar", degraded=False)

    async def _upcoming(
        self, filters: RecommendationFilters, exclude: list[UUID]
    ) -> RecommendationPage:
        documents = await self.catalog.upcoming(filters, exclude)
        now = datetime.now(UTC)
        unique = {
            document.id: document
            for document in documents
            if document.id not in exclude and matches(document, filters, now)
        }
        ordered = sorted(unique.values(), key=lambda document: (document.starts_at, document.id))
        return RecommendationPage(
            items=[
                RecommendationItem(event=document, reason="UPCOMING")
                for document in ordered[: filters.limit]
            ],
            mode="upcoming",
            degraded=True,
        )

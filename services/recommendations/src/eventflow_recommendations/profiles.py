"""Actor-scoped explicit preferences and prepared-vector personal recommendations."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pgvector import Vector
from pydantic import ValidationError

from .contracts import (
    Favorite,
    PreferenceInput,
    ProfileState,
    RecommendationFilters,
    RecommendationItem,
    RecommendationPage,
)
from .database import Pool
from .errors import ApiError
from .interests import INTEREST_IDS
from .ranking import Catalog, matches, nearest_candidates, prepared_vector


def centroid(values: list[object]) -> Vector | None:
    vectors = [valid.to_list() for value in values if (valid := prepared_vector(value)) is not None]
    if not vectors:
        return None
    total = [sum(components) for components in zip(*vectors, strict=True)]
    norm = math.sqrt(sum(component * component for component in total))
    if not math.isfinite(norm) or norm <= 1e-10:
        return None
    return prepared_vector([component / norm for component in total])


class Profiles:
    def __init__(self, pool: Pool, catalog: Catalog) -> None:
        self.pool, self.catalog = pool, catalog

    async def get(self, actor: UUID) -> ProfileState:
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            profile = await (
                await conn.execute(
                    "SELECT revision,interests FROM recommendation_profiles WHERE actor=%s",
                    (actor,),
                )
            ).fetchone()
            rows = await (
                await conn.execute(
                    "SELECT event_id FROM recommendation_favorites WHERE actor=%s "
                    "ORDER BY created_at,event_id",
                    (actor,),
                )
            ).fetchall()
        ids = [row["event_id"] for row in rows]
        documents = await self.catalog.hydrate(ids) if ids else []
        current = {document.id: document for document in documents}
        return ProfileState(
            revision=profile["revision"] if profile else 0,
            interests=sorted(profile["interests"]) if profile else [],
            favorites=[
                Favorite.model_validate({"eventId": id, "event": current.get(id)}) for id in ids
            ],
        )

    async def save_interests(
        self, actor: UUID, expected_revision: int, interests: list[str]
    ) -> ProfileState:
        try:
            values = PreferenceInput(revision=expected_revision, interests=interests)
        except ValidationError as error:
            raise ApiError(422, "VALIDATION_FAILED", "Invalid interests") from error
        if not set(values.interests).issubset(INTEREST_IDS):
            raise ApiError(422, "VALIDATION_FAILED", "Unknown interest")
        desired = sorted(values.interests)
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "INSERT INTO recommendation_profiles(actor) VALUES (%s) ON CONFLICT DO NOTHING",
                (actor,),
            )
            profile = await (
                await conn.execute(
                    "SELECT revision,interests FROM recommendation_profiles "
                    "WHERE actor=%s FOR UPDATE",
                    (actor,),
                )
            ).fetchone()
            assert profile is not None
            if sorted(profile["interests"]) != desired:
                if profile["revision"] != values.revision:
                    raise ApiError(409, "PROFILE_CHANGED", "Preferences changed; reload and retry")
                await conn.execute(
                    "UPDATE recommendation_profiles SET interests=%s,revision=revision+1,"
                    "updated_at=clock_timestamp() WHERE actor=%s",
                    (desired, actor),
                )
        return await self.get(actor)

    async def favorite(self, actor: UUID, event_id: UUID, enabled: bool) -> ProfileState:
        if enabled:
            current = await self.catalog.hydrate([event_id])
            if not any(document.id == event_id for document in current):
                raise ApiError(404, "NOT_FOUND", "Event is unavailable")
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "INSERT INTO recommendation_profiles(actor) VALUES (%s) ON CONFLICT DO NOTHING",
                (actor,),
            )
            await conn.execute(
                "SELECT actor FROM recommendation_profiles WHERE actor=%s FOR UPDATE", (actor,)
            )
            exists = await (
                await conn.execute(
                    "SELECT 1 FROM recommendation_favorites WHERE actor=%s AND event_id=%s",
                    (actor, event_id),
                )
            ).fetchone()
            if bool(exists) != enabled:
                if enabled:
                    count = await (
                        await conn.execute(
                            "SELECT count(*) AS count FROM recommendation_favorites WHERE actor=%s",
                            (actor,),
                        )
                    ).fetchone()
                    assert count is not None
                    if count["count"] >= 100:
                        raise ApiError(409, "FAVORITES_LIMIT", "At most 100 favorites are allowed")
                    await conn.execute(
                        "INSERT INTO recommendation_favorites(actor,event_id) VALUES (%s,%s)",
                        (actor, event_id),
                    )
                else:
                    await conn.execute(
                        "DELETE FROM recommendation_favorites WHERE actor=%s AND event_id=%s",
                        (actor, event_id),
                    )
                await conn.execute(
                    "UPDATE recommendation_profiles SET revision=revision+1,"
                    "updated_at=clock_timestamp() WHERE actor=%s",
                    (actor,),
                )
        return await self.get(actor)

    async def feed(self, actor: UUID, filters: RecommendationFilters) -> RecommendationPage:
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            projection = await (
                await conn.execute(
                    "SELECT active_generation,active_model FROM recommendation_projection "
                    "WHERE id=1"
                )
            ).fetchone()
            profile = await (
                await conn.execute(
                    "SELECT interests FROM recommendation_profiles WHERE actor=%s", (actor,)
                )
            ).fetchone()
            favorites = await (
                await conn.execute(
                    "SELECT event_id FROM recommendation_favorites WHERE actor=%s "
                    "ORDER BY event_id",
                    (actor,),
                )
            ).fetchall()
            excluded = [row["event_id"] for row in favorites]
            interests = profile["interests"] if profile else []
            explicit = bool(interests or excluded)
            candidates = None
            favorite_context = None
            if projection and projection["active_generation"] and projection["active_model"]:
                generation = projection["active_generation"]
                saved = await (
                    await conn.execute(
                        "SELECT embedding FROM recommendation_documents WHERE generation=%s "
                        "AND event_id=ANY(%s::uuid[]) AND embedding IS NOT NULL",
                        (generation, excluded),
                    )
                ).fetchall()
                favorite_context = centroid([row["embedding"] for row in saved])
                prepared_interests = await (
                    await conn.execute(
                        "SELECT interest_id,embedding FROM recommendation_interest_vectors "
                        "WHERE generation=%s",
                        (generation,),
                    )
                ).fetchall()
                interest_context = None
                if {row["interest_id"] for row in prepared_interests} == INTEREST_IDS:
                    interest_context = centroid(
                        [
                            row["embedding"]
                            for row in prepared_interests
                            if row["interest_id"] in interests
                        ]
                    )
                context = centroid([favorite_context, interest_context])
                if context is not None:
                    candidates = await nearest_candidates(
                        conn, generation, context, filters, excluded, datetime.now(UTC)
                    )
        if candidates is None:
            documents = await self.catalog.upcoming(filters, excluded)
            now = datetime.now(UTC)
            unique = {
                document.id: document
                for document in documents
                if document.id not in excluded and matches(document, filters, now)
            }
            ordered = sorted(
                unique.values(), key=lambda document: (document.starts_at, document.id)
            )
            return RecommendationPage(
                items=[
                    RecommendationItem(event=document, reason="UPCOMING")
                    for document in ordered[: filters.limit]
                ],
                mode="upcoming",
                degraded=explicit,
            )
        documents = await self.catalog.hydrate(candidates) if candidates else []
        current = {document.id: document for document in documents}
        now = datetime.now(UTC)
        reason: Literal["FAVORITES", "INTERESTS"] = (
            "FAVORITES" if favorite_context is not None else "INTERESTS"
        )
        return RecommendationPage(
            items=[
                RecommendationItem(event=current[id], reason=reason)
                for id in candidates
                if id in current and matches(current[id], filters, now)
            ][: filters.limit],
            mode="personal",
            degraded=False,
        )

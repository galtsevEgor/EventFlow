from __future__ import annotations

import asyncio
import math
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from pgvector import Vector
from psycopg import Error as DatabaseError
from psycopg.types.json import Jsonb

from eventflow_recommendations import profiles as module
from eventflow_recommendations.contracts import RecommendationFilters, SourceDocument
from eventflow_recommendations.errors import ApiError
from eventflow_recommendations.interests import INTERESTS
from eventflow_recommendations.profiles import Profiles, centroid


class Catalog:
    def __init__(self, documents=(), pool=None):
        self.documents = {doc.id: doc for doc in documents}
        self.pool = pool
        self.failure = False
        self.calls = []

    async def check(self):
        if self.failure:
            raise RuntimeError("Synthetic Catalog failure")
        if self.pool:
            async with self.pool.connection() as conn:
                rows = await (
                    await conn.execute(
                        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() "
                        "AND state='idle in transaction' AND pid<>pg_backend_pid()"
                    )
                ).fetchall()
                assert not rows

    async def hydrate(self, ids):
        await self.check()
        self.calls.append(ids)
        return [self.documents[id] for id in ids if id in self.documents]

    async def upcoming(self, filters, exclude):
        await self.check()
        return list(self.documents.values())


def document(id=None, **changes):
    starts = datetime.now(UTC) + timedelta(days=30)
    values = {
        "id": str(id or uuid4()),
        "title": "Current public title",
        "description": "Live jazz",
        "city": "Chisinau",
        "address": "Test1",
        "timeZone": "Europe/Chisinau",
        "startsAt": starts.isoformat(),
        "endsAt": (starts + timedelta(hours=2)).isoformat(),
        "localDate": starts.date().isoformat(),
        "minPriceMinor": 1000,
        "currency": "EUR",
        "capacity": 100,
        "coverId": None,
    }
    values.update(changes)
    return SourceDocument.model_validate(values)


def axis(index=0, value=1.0):
    result = [0.0] * 384
    result[index] = value
    return result


async def seed_projection(pool, documents=(), interests=None, *, activate=True):
    generation = uuid4()
    async with pool.connection() as conn, conn.transaction():
        if activate:
            await conn.execute(
                "INSERT INTO recommendation_projection "
                "(id,building_generation,building_model,active_generation,active_model) "
                "VALUES (1,%s,'model1',%s,'model1') ON CONFLICT(id) DO UPDATE "
                "SET active_generation=EXCLUDED.active_generation,"
                "building_generation=EXCLUDED.building_generation",
                (generation, generation),
            )
        for position, (doc, embedding) in enumerate(documents, start=1):
            await conn.execute(
                "INSERT INTO recommendation_documents VALUES (%s,%s,%s,%s,%s)",
                (
                    generation,
                    doc.id,
                    position,
                    Jsonb(doc.model_dump(mode="json", by_alias=True)),
                    Vector(embedding),
                ),
            )
        if interests is not None:
            for interest in INTERESTS:
                await conn.execute(
                    "INSERT INTO recommendation_interest_vectors VALUES (%s,%s,%s)",
                    (generation, interest.id, Vector(interests.get(interest.id, axis()))),
                )
    return generation


@pytest.mark.integration
class TestProfiles:
    async def test_get_missing_is_read_only_and_actor_isolated_current_hydration(
        self, projection_pool
    ):
        actor, other = uuid4(), uuid4()
        favorite, removed = document(), document()
        catalog = Catalog([favorite, removed], projection_pool)
        profiles = Profiles(projection_pool, catalog)
        empty = await profiles.get(actor)
        assert empty.revision == 0 and empty.interests == [] and empty.favorites == []
        async with projection_pool.connection() as conn:
            assert (
                await (
                    await conn.execute("SELECT count(*) AS count FROM recommendation_profiles")
                ).fetchone()
            )["count"] == 0
        await profiles.favorite(actor, favorite.id, True)
        await profiles.favorite(actor, removed.id, True)
        await profiles.save_interests(actor, 2, ["jazz"])
        catalog.documents[favorite.id] = favorite.model_copy(
            update={"title": "Latest Catalog title"}
        )
        del catalog.documents[removed.id]
        result = await profiles.get(actor)
        assert result.interests == ["jazz"]
        assert result.favorites[0].event.title == "Latest Catalog title"
        assert result.favorites[1].event_id == removed.id and result.favorites[1].event is None
        alien = await profiles.get(other)
        assert alien.revision == 0 and alien.favorites == [] and alien.interests == []
        await profiles.favorite(other, favorite.id, False)
        assert len((await profiles.get(actor)).favorites) == 2

    async def test_interests_revision_canonical_noop_lost_ack_and_conflict(self, projection_pool):
        profiles = Profiles(projection_pool, Catalog(pool=projection_pool))
        actor = uuid4()
        first = await profiles.save_interests(actor, 0, ["theatre", "jazz"])
        assert first.interests == ["jazz", "theatre"] and first.revision == 1
        retried = await profiles.save_interests(actor, 0, ["jazz", "theatre"])
        assert retried == first
        with pytest.raises(ApiError) as error:
            await profiles.save_interests(actor, 0, ["rock"])
        assert error.value.status == 409 and error.value.code == "PROFILE_CHANGED"
        assert await profiles.get(actor) == first
        changed = await profiles.save_interests(actor, 1, [])
        assert changed.revision == 2 and changed.interests == []

    @pytest.mark.parametrize(
        "interests", [["secret"], ["jazz", "jazz"], [i.id for i in INTERESTS[:9]]]
    )
    async def test_invalid_interests_have_no_database_effects(self, projection_pool, interests):
        actor = uuid4()
        with pytest.raises(ApiError) as error:
            await Profiles(projection_pool, Catalog()).save_interests(actor, 0, interests)
        assert error.value.status == 422
        async with projection_pool.connection() as conn:
            assert not await (
                await conn.execute("SELECT * FROM recommendation_profiles")
            ).fetchall()

    async def test_duplicate_favorites_revision_stable_delete_unavailable_allowed(
        self, projection_pool
    ):
        actor, event = uuid4(), document()
        catalog = Catalog([event], projection_pool)
        profiles = Profiles(projection_pool, catalog)
        first = await profiles.favorite(actor, event.id, True)
        assert first.revision == 1 and len(first.favorites) == 1
        again = await profiles.favorite(actor, event.id, True)
        assert again == first
        del catalog.documents[event.id]
        removed = await profiles.favorite(actor, event.id, False)
        assert removed.revision == 2 and removed.favorites == []
        assert await profiles.favorite(actor, event.id, False) == removed
        with pytest.raises(ApiError) as error:
            await profiles.favorite(actor, event.id, True)
        assert error.value.status == 404
        assert await profiles.get(actor) == removed

    async def test_concurrent_favorites_cap_is_serialized_per_actor(self, projection_pool):
        actor = uuid4()
        documents = [document() for _ in range(101)]
        async with projection_pool.connection() as conn, conn.transaction():
            await conn.execute("INSERT INTO recommendation_profiles(actor) VALUES (%s)", (actor,))
            for doc in documents[:99]:
                await conn.execute(
                    "INSERT INTO recommendation_favorites(actor,event_id) VALUES (%s,%s)",
                    (actor, doc.id),
                )
        profiles = Profiles(projection_pool, Catalog(documents))
        results = await asyncio.gather(
            profiles.favorite(actor, documents[99].id, True),
            profiles.favorite(actor, documents[100].id, True),
            return_exceptions=True,
        )
        errors = [result for result in results if isinstance(result, ApiError)]
        assert len(errors) == 1 and errors[0].code == "FAVORITES_LIMIT"
        final = await profiles.get(actor)
        assert len(final.favorites) == 100 and final.revision == 1
        assert (
            sum(
                favorite.event_id in [doc.id for doc in documents[99:]]
                for favorite in final.favorites
            )
            == 1
        )

    async def test_failed_source_and_sql_mutation_leave_no_partial_effects(self, projection_pool):
        actor, event = uuid4(), document()
        catalog = Catalog([event], projection_pool)
        profiles = Profiles(projection_pool, catalog)
        catalog.failure = True
        with pytest.raises(RuntimeError, match="Catalog failure"):
            await profiles.favorite(actor, event.id, True)
        catalog.failure = False
        assert (await profiles.get(actor)).revision == 0
        async with projection_pool.connection() as conn:
            await conn.execute(
                "CREATE FUNCTION reject_favorite() RETURNS trigger LANGUAGE plpgsql "
                "AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$"
            )
            await conn.execute(
                "CREATE TRIGGER reject_favorite BEFORE INSERT ON recommendation_favorites "
                "FOR EACH ROW EXECUTE FUNCTION reject_favorite()"
            )
        with pytest.raises(DatabaseError, match="synthetic failure"):
            await profiles.favorite(actor, event.id, True)
        async with projection_pool.connection() as conn:
            assert not await (
                await conn.execute("SELECT * FROM recommendation_profiles")
            ).fetchall()
            assert not await (
                await conn.execute("SELECT * FROM recommendation_favorites")
            ).fetchall()

    async def test_cold_start_warmup_and_valid_empty_modes_are_truthful(self, projection_pool):
        actor, upcoming = uuid4(), document()
        catalog = Catalog([upcoming], projection_pool)
        profiles = Profiles(projection_pool, catalog)
        fresh = await profiles.feed(actor, RecommendationFilters())
        assert (
            fresh.mode == "upcoming" and not fresh.degraded and fresh.items[0].reason == "UPCOMING"
        )
        await profiles.save_interests(actor, 0, ["jazz"])
        warming = await profiles.feed(actor, RecommendationFilters())
        assert warming.mode == "upcoming" and warming.degraded
        await seed_projection(projection_pool, interests={})
        available = await profiles.feed(actor, RecommendationFilters())
        assert available.mode == "personal" and not available.degraded and available.items == []
        async with projection_pool.connection() as conn:
            await conn.execute(
                "DELETE FROM recommendation_interest_vectors WHERE interest_id='food'"
            )
        incomplete = await profiles.feed(actor, RecommendationFilters())
        assert incomplete.mode == "upcoming" and incomplete.degraded

    async def test_mixed_groups_equal_weight_normalized_exclude_all_favorites_and_rehydrate(
        self, projection_pool, monkeypatch
    ):
        actor = uuid4()
        favorites = [document() for _ in range(3)]
        expired = favorites[0].model_copy(
            update={"starts_at": datetime.now(UTC) - timedelta(days=1)}
        )
        best, wrong_city, removed = document(), document(), document()
        catalog = Catalog([*favorites, best, wrong_city, removed], projection_pool)
        profiles = Profiles(projection_pool, catalog)
        for favorite in favorites:
            await profiles.favorite(actor, favorite.id, True)
        await profiles.save_interests(actor, 3, ["jazz"])
        await seed_projection(
            projection_pool,
            [
                (expired, axis()),
                (favorites[1], axis()),
                (favorites[2], axis()),
                (best, [1 / math.sqrt(2), 1 / math.sqrt(2)] + [0.0] * 382),
                (wrong_city, axis()),
                (removed, axis()),
            ],
            interests={"jazz": axis(1)},
        )
        del catalog.documents[removed.id]
        catalog.documents[wrong_city.id] = wrong_city.model_copy(update={"city": "Balti"})
        catalog.documents[best.id] = best.model_copy(update={"title": "New current title"})
        captured = []
        original = module.nearest_candidates

        async def inspect(conn, generation, vector, filters, exclude, now):
            captured.append((vector.to_list(), exclude))
            return await original(conn, generation, vector, filters, exclude, now)

        monkeypatch.setattr(module, "nearest_candidates", inspect)
        result = await profiles.feed(actor, RecommendationFilters(city="Chisinau"))
        assert result.mode == "personal" and not result.degraded
        assert len(result.items) == 1 and result.items[0].event.id == best.id
        assert (
            result.items[0].event.title == "New current title"
            and result.items[0].reason == "FAVORITES"
        )
        assert set(captured[0][1]) == {doc.id for doc in favorites}
        assert captured[0][0][:2] == pytest.approx([1 / math.sqrt(2)] * 2)
        assert sum(value * value for value in captured[0][0]) == pytest.approx(1)

    async def test_interests_only_reason_and_generation_snapshot(
        self, projection_pool, monkeypatch
    ):
        actor = uuid4()
        old, new = document(), document()
        catalog = Catalog([old, new], projection_pool)
        profiles = Profiles(projection_pool, catalog)
        await profiles.save_interests(actor, 0, ["jazz"])
        old_generation = await seed_projection(projection_pool, [(old, axis())], interests={})
        new_generation = await seed_projection(
            projection_pool, [(new, axis(1))], interests={"jazz": axis(1)}, activate=False
        )
        original = module.nearest_candidates

        async def activate(conn, generation, *args):
            assert generation == old_generation
            async with projection_pool.connection() as writer, writer.transaction():
                await writer.execute(
                    "UPDATE recommendation_projection SET active_generation=%s", (new_generation,)
                )
                await writer.execute(
                    "DELETE FROM recommendation_documents WHERE generation=%s", (old_generation,)
                )
                await writer.execute(
                    "DELETE FROM recommendation_interest_vectors WHERE generation=%s",
                    (old_generation,),
                )
            return await original(conn, generation, *args)

        monkeypatch.setattr(module, "nearest_candidates", activate)
        first = await profiles.feed(actor, RecommendationFilters())
        assert [item.event.id for item in first.items] == [old.id]
        assert first.items[0].reason == "INTERESTS"
        monkeypatch.setattr(module, "nearest_candidates", original)
        second = await profiles.feed(actor, RecommendationFilters())
        assert [item.event.id for item in second.items] == [new.id]

    async def test_concurrent_interest_updates_conflict_instead_of_overwrite(self, projection_pool):
        actor = uuid4()
        profiles = Profiles(projection_pool, Catalog())
        results = await asyncio.gather(
            profiles.save_interests(actor, 0, ["jazz"]),
            profiles.save_interests(actor, 0, ["rock"]),
            return_exceptions=True,
        )
        errors = [result for result in results if isinstance(result, ApiError)]
        assert len(errors) == 1 and errors[0].code == "PROFILE_CHANGED"
        final = await profiles.get(actor)
        assert final.revision == 1 and final.interests in (["jazz"], ["rock"])

    async def test_expired_favorite_context_and_cancelled_groups_fallback(self, projection_pool):
        actor, favorite, upcoming = uuid4(), document(), document()
        catalog = Catalog([favorite, upcoming], projection_pool)
        profiles = Profiles(projection_pool, catalog)
        await profiles.favorite(actor, favorite.id, True)
        expired = favorite.model_copy(update={"starts_at": datetime.now(UTC) - timedelta(days=1)})
        await seed_projection(
            projection_pool,
            [(expired, axis()), (upcoming, axis())],
            interests={"jazz": axis(value=-1)},
        )
        del catalog.documents[favorite.id]
        result = await profiles.feed(actor, RecommendationFilters())
        assert result.mode == "personal" and result.items[0].reason == "FAVORITES"
        assert [item.event.id for item in result.items] == [upcoming.id]
        await profiles.save_interests(actor, 1, ["jazz"])
        cancelled = await profiles.feed(actor, RecommendationFilters())
        assert cancelled.mode == "upcoming" and cancelled.degraded
        assert [item.event.id for item in cancelled.items] == [upcoming.id]

    async def test_postcommit_catalog_failure_retries_without_double_revision(
        self, projection_pool
    ):
        actor, event = uuid4(), document()

        class LostAckCatalog(Catalog):
            attempts = 0

            async def hydrate(self, ids):
                self.attempts += 1
                if self.attempts == 2:
                    raise RuntimeError("Lost response after committed mutation")
                return await super().hydrate(ids)

        catalog = LostAckCatalog([event], projection_pool)
        profiles = Profiles(projection_pool, catalog)
        with pytest.raises(RuntimeError, match="Lost response"):
            await profiles.favorite(actor, event.id, True)
        async with projection_pool.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT revision FROM recommendation_profiles WHERE actor=%s", (actor,)
                )
            ).fetchone()
            assert row["revision"] == 1
            saved = await (
                await conn.execute(
                    "SELECT event_id FROM recommendation_favorites WHERE actor=%s", (actor,)
                )
            ).fetchall()
            assert saved == [{"event_id": event.id}]
        retry = await profiles.favorite(actor, event.id, True)
        assert retry.revision == 1 and len(retry.favorites) == 1


def test_centroid_group_weight_normalization_missing_and_cancellation():
    assert centroid([]) is None
    assert centroid([None, [0] * 384]) is None
    assert centroid([Vector(axis()), Vector(axis(value=-1))]) is None
    group = centroid([Vector(axis())] * 3)
    combined = centroid([group, Vector(axis(1))])
    assert combined.to_list()[:2] == pytest.approx([1 / math.sqrt(2)] * 2)


def test_profiles_import_does_not_load_torch_or_weights():
    source = (
        "import sys;sys.path.insert(0,sys.argv[1]);import eventflow_recommendations.profiles;"
        "assert 'torch' not in sys.modules;assert 'sentence_transformers' not in sys.modules;"
        "assert 'eventflow_recommendations.embeddings' not in sys.modules"
    )
    result = subprocess.run(
        [sys.executable, "-c", source, str(Path(__file__).resolve().parents[1] / "src")],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr

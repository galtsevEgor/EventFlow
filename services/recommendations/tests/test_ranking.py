from __future__ import annotations

import math
import subprocess
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from pgvector import Vector
from psycopg.types.json import Jsonb

from eventflow_recommendations import ranking
from eventflow_recommendations.contracts import RecommendationFilters, SourceDocument
from eventflow_recommendations.errors import ApiError
from eventflow_recommendations.ranking import Recommendations, matches, prepared_vector

NOW = datetime.now(UTC)
FUTURE = NOW + timedelta(days=30)


def document(event_id: UUID | None = None, **changes) -> SourceDocument:
    values = {
        "id": str(event_id or uuid4()),
        "title": "Jazz concert",
        "description": "Live jazz",
        "city": "Chisinau",
        "address": "Test1",
        "timeZone": "Europe/Chisinau",
        "startsAt": FUTURE.isoformat(),
        "endsAt": (FUTURE + timedelta(hours=2)).isoformat(),
        "localDate": FUTURE.date().isoformat(),
        "minPriceMinor": 1000,
        "currency": "EUR",
        "capacity": 100,
        "coverId": None,
    }
    values.update(changes)
    return SourceDocument.model_validate(values)


def vector(similarity: float = 1) -> list[float]:
    return [similarity, math.sqrt(1 - similarity * similarity)] + [0.0] * 382


class FakeCatalog:
    def __init__(self, documents: list[SourceDocument], pool=None):
        self.documents = {doc.id: doc for doc in documents}
        self.calls = []
        self.upcoming_calls = []
        self.pool = pool

    async def assert_outside_transaction(self):
        if self.pool:
            async with self.pool.connection() as conn:
                row = await (
                    await conn.execute(
                        "SELECT count(*) AS count FROM pg_stat_activity "
                        "WHERE datname=current_database() AND state='idle in transaction' "
                        "AND pid<>pg_backend_pid()"
                    )
                ).fetchone()
                assert row["count"] == 0

    async def hydrate(self, ids):
        await self.assert_outside_transaction()
        assert len(ids) <= 60 and len(set(ids)) == len(ids)
        self.calls.append(ids)
        return [self.documents[event] for event in reversed(ids) if event in self.documents]

    async def upcoming(self, filters, exclude):
        await self.assert_outside_transaction()
        self.upcoming_calls.append((filters, exclude))
        return list(reversed(self.documents.values()))


async def seed(pool, source: SourceDocument, candidates, *, generation=None, activate=True):
    generation = generation or uuid4()
    async with pool.connection() as conn, conn.transaction():
        if activate:
            await conn.execute(
                "INSERT INTO recommendation_projection "
                "(id,building_generation,building_model,active_generation,active_model) "
                "VALUES (1,%s,'model1',%s,'model1') ON CONFLICT(id) DO UPDATE "
                "SET building_generation=EXCLUDED.building_generation,"
                "active_generation=EXCLUDED.active_generation",
                (generation, generation),
            )
        for position, (doc, embedding) in enumerate([(source, vector()), *candidates], start=1):
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
    return generation


@pytest.mark.integration
class TestSimilarRanking:
    async def test_similarity_order_ties_source_exclusion_city_and_no_http_transaction(
        self, projection_pool
    ):
        source = document()
        first = document(UUID(int=1))
        second = document(UUID(int=2))
        third = document(UUID(int=3))
        wrong_city = document(city="Balti")
        await seed(
            projection_pool,
            source,
            [
                (second, vector(0.9)),
                (third, vector(0.6)),
                (first, vector(0.9)),
                (wrong_city, vector()),
            ],
        )
        catalog = FakeCatalog([source, first, second, third, wrong_city], projection_pool)
        result = await Recommendations(projection_pool, catalog).similar(
            source.id, RecommendationFilters(limit=3)
        )
        assert result.mode == "similar" and not result.degraded
        assert [item.event.id for item in result.items] == [first.id, second.id, third.id]
        assert all(item.reason == "SIMILAR" for item in result.items)
        assert source.id not in catalog.calls[1] and wrong_city.id not in catalog.calls[1]
        assert not catalog.upcoming_calls

    async def test_projected_filters_then_current_changes_removal_and_pause(self, projection_pool):
        source = document()
        selected = document()
        changed_city = document()
        changed_price = document()
        changed_start = document()
        changed_date = document()
        removed = document()
        paused = document()
        wrong_projected_date = document(localDate=(FUTURE.date() + timedelta(days=1)).isoformat())
        wrong_projected_price = document(minPriceMinor=3000)
        projected_past = document(startsAt=(NOW - timedelta(hours=1)).isoformat())
        candidates = [
            selected,
            changed_city,
            changed_price,
            changed_start,
            changed_date,
            removed,
            paused,
            wrong_projected_date,
            wrong_projected_price,
            projected_past,
        ]
        await seed(projection_pool, source, [(doc, vector(0.9)) for doc in candidates])
        catalog = FakeCatalog(
            [
                source,
                selected.model_copy(update={"title": "Current Catalog title"}),
                changed_city.model_copy(update={"city": "Balti"}),
                changed_price.model_copy(update={"min_price_minor": 2500}),
                changed_start.model_copy(update={"starts_at": NOW - timedelta(minutes=1)}),
                changed_date.model_copy(update={"local_date": FUTURE.date() + timedelta(days=1)}),
                wrong_projected_date,
                wrong_projected_price,
                projected_past,
            ],
            projection_pool,
        )
        filters = RecommendationFilters.model_validate(
            {
                "from": FUTURE.date().isoformat(),
                "to": FUTURE.date().isoformat(),
                "minPriceMinor": 500,
                "maxPriceMinor": 1500,
            }
        )
        result = await Recommendations(projection_pool, catalog).similar(source.id, filters)
        assert [item.event.id for item in result.items] == [selected.id]
        assert result.items[0].event.title == "Current Catalog title"
        assert wrong_projected_date.id not in catalog.calls[1]
        assert wrong_projected_price.id not in catalog.calls[1]
        assert projected_past.id not in catalog.calls[1]

    async def test_explicit_city_and_local_date_price_inclusive_boundaries(self, projection_pool):
        source = document()
        selected = document(city="Balti", minPriceMinor=1500)
        await seed(projection_pool, source, [(selected, vector(0.7))])
        result = await Recommendations(projection_pool, FakeCatalog([source, selected])).similar(
            source.id,
            RecommendationFilters.model_validate(
                {
                    "city": "Balti",
                    "from": FUTURE.date().isoformat(),
                    "to": FUTURE.date().isoformat(),
                    "minPriceMinor": 1500,
                    "maxPriceMinor": 1500,
                }
            ),
        )
        assert [item.event.id for item in result.items] == [selected.id]

    async def test_cold_start_and_missing_source_embedding_upcoming_are_labeled(
        self, projection_pool
    ):
        source = document()
        first = document(UUID(int=1))
        second = document(UUID(int=2))
        wrong_city = document(city="Balti")
        past = document(startsAt=(NOW - timedelta(days=1)).isoformat())
        catalog = FakeCatalog([source, second, first, wrong_city, past], projection_pool)
        ranking_service = Recommendations(projection_pool, catalog)
        result = await ranking_service.similar(source.id, RecommendationFilters(limit=2))
        assert result.mode == "upcoming" and result.degraded
        assert [item.event.id for item in result.items] == [first.id, second.id]
        assert all(item.reason == "UPCOMING" for item in result.items)
        assert catalog.upcoming_calls[0][0].city == source.city
        assert catalog.upcoming_calls[0][1] == [source.id]
        await seed(projection_pool, source, [])
        async with projection_pool.connection() as conn:
            await conn.execute("UPDATE recommendation_documents SET document=NULL,embedding=NULL")
        again = await ranking_service.similar(source.id, RecommendationFilters(limit=2))
        assert again.mode == "upcoming" and again.degraded

    async def test_valid_empty_vector_result_stays_similar(self, projection_pool):
        source, other = document(), document(city="Balti")
        await seed(projection_pool, source, [(other, vector())])
        catalog = FakeCatalog([source, other])
        result = await Recommendations(projection_pool, catalog).similar(
            source.id, RecommendationFilters()
        )
        assert result.mode == "similar" and not result.degraded and result.items == []
        assert not catalog.upcoming_calls

    async def test_bounded_candidates_and_response_without_confidence_scores(self, projection_pool):
        source = document()
        candidates = [document(UUID(int=i + 1)) for i in range(100)]
        await seed(
            projection_pool,
            source,
            [(doc, vector(1 - i / 200)) for i, doc in enumerate(candidates)],
        )
        catalog = FakeCatalog([source, *candidates])
        result = await Recommendations(projection_pool, catalog).similar(
            source.id, RecommendationFilters(limit=12)
        )
        assert len(catalog.calls[1]) == 60
        assert [item.event.id for item in result.items] == [doc.id for doc in candidates[:12]]
        assert set(result.items[0].model_dump()) == {"event", "reason"}

    async def test_concurrent_activation_and_retirement_use_single_generation_snapshot(
        self, projection_pool, monkeypatch
    ):
        source, old_event, new_event = document(), document(), document()
        old_generation = await seed(projection_pool, source, [(old_event, vector(0.9))])
        new_generation = await seed(
            projection_pool, source, [(new_event, vector(0.9))], activate=False
        )
        original = ranking.nearest_candidates
        observed = []

        async def swap(connection, generation, *args):
            observed.append(generation)
            async with projection_pool.connection() as writer, writer.transaction():
                await writer.execute(
                    "UPDATE recommendation_projection SET active_generation=%s,"
                    "building_generation=%s,active_model='model2',building_model='model2'",
                    (new_generation, new_generation),
                )
                await writer.execute(
                    "DELETE FROM recommendation_documents WHERE generation=%s", (old_generation,)
                )
            return await original(connection, generation, *args)

        monkeypatch.setattr(ranking, "nearest_candidates", swap)
        catalog = FakeCatalog([source, old_event, new_event], projection_pool)
        result = await Recommendations(projection_pool, catalog).similar(
            source.id, RecommendationFilters()
        )
        assert observed == [old_generation]
        assert [item.event.id for item in result.items] == [old_event.id]
        monkeypatch.setattr(ranking, "nearest_candidates", original)
        again = await Recommendations(projection_pool, catalog).similar(
            source.id, RecommendationFilters()
        )
        assert [item.event.id for item in again.items] == [new_event.id]


@pytest.mark.parametrize("source", [None, document(startsAt=(NOW - timedelta(days=1)).isoformat())])
async def test_source_must_be_current_and_upcoming_before_any_sql(source):
    event_id = source.id if source else uuid4()

    class NoPool:
        def connection(self):
            raise AssertionError("SQL must not run for missing/currently unavailable source")

    with pytest.raises(ApiError) as error:
        await Recommendations(NoPool(), FakeCatalog([source] if source else [])).similar(
            event_id, RecommendationFilters()
        )
    assert error.value.status == 404 and error.value.code == "NOT_FOUND"


@pytest.mark.parametrize(
    "values", [None, [], [0] * 384, [float("nan")] * 384, [1] * 383, [2] * 384]
)
def test_bad_prepared_vectors_never_trigger_model_loading(values):
    assert prepared_vector(values) is None


def test_prepared_vector_and_filter_current_boundaries():
    assert prepared_vector(vector()) is not None
    assert prepared_vector(Vector(vector())) is not None
    current = document()
    filters = RecommendationFilters.model_validate(
        {
            "city": "Chisinau",
            "from": FUTURE.date().isoformat(),
            "to": FUTURE.date().isoformat(),
            "minPriceMinor": 1000,
            "maxPriceMinor": 1000,
        }
    )
    assert matches(current, filters, NOW)
    assert not matches(current, filters, FUTURE)
    assert not matches(current.model_copy(update={"local_date": date(2000, 1, 1)}), filters, NOW)


def test_ranking_import_does_not_load_ml_model_libraries():
    source = (
        "import sys; sys.path.insert(0,sys.argv[1]); import eventflow_recommendations.ranking; "
        "assert 'torch' not in sys.modules; assert 'sentence_transformers' not in sys.modules; "
        "assert 'eventflow_recommendations.embeddings' not in sys.modules"
    )
    completed = subprocess.run(
        [sys.executable, "-c", source, str(Path(__file__).resolve().parents[1] / "src")],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr

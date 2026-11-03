"""Isolated synthetic pgvector performance diagnostics; never a user-quality benchmark."""

from __future__ import annotations

import asyncio
import math
import os
import random
import statistics
import subprocess
import time
from collections import Counter
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

from pgvector import Vector
from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection, sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .contracts import RecommendationFilters, SourceDocument
from .database import Row, migrate
from .ranking import nearest_candidates

ROWS = 5000
SEED = 210214
MIN_RECALL = 0.95
DIAGNOSTIC_EF_SEARCH = 1000


class BenchmarkError(ValueError):
    """Safe fixed diagnostic; never includes credentials or connection URLs."""


MODES = ("exact", "100", "400", "1000")
EXCLUDED = [UUID(int=2)]


def performance_vectors(vectors: list[list[float]], count: int = ROWS) -> list[list[float]]:
    rng = random.Random(SEED)
    result = []
    for index in range(count):
        values = [value + rng.gauss(0, 0.01) for value in vectors[index % len(vectors)]]
        norm = math.sqrt(sum(value * value for value in values))
        result.append([value / norm for value in values])
    return result


def plan_nodes(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [plan, *[node for child in plan.get("Plans", []) for node in plan_nodes(child)]]


def latency_summary(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {
        "p50Ms": statistics.median(ordered),
        "p95Ms": ordered[math.ceil(len(ordered) * 0.95) - 1],
    }


def verify_local_database_urls(admin_url: str, application_url: str) -> None:
    for value in (admin_url, application_url):
        parsed = urlsplit(value)
        if (
            parsed.scheme not in ("postgres", "postgresql")
            or parsed.hostname != "127.0.0.1"
            or parsed.port != 26432
            or parsed.query
            or parsed.fragment
        ):
            raise BenchmarkError(
                "Benchmark requires dedicated local vector PostgreSQL on port 26432"
            )


def filters() -> RecommendationFilters:
    return RecommendationFilters.model_validate(
        {
            "city": "Chisinau",
            "from": "2030-01-01",
            "to": "2039-12-31",
            "minPriceMinor": 1000,
            "maxPriceMinor": 2000,
        }
    )


QUERY = (
    "SELECT event_id AS id,embedding<=>%s AS distance FROM recommendation_documents "
    "WHERE generation=%s AND document IS NOT NULL AND embedding IS NOT NULL "
    "AND NOT (event_id=ANY(%s::uuid[])) "
    "AND (document->>'startsAt')::timestamptz>clock_timestamp() "
    "AND lower(document->>'city')=lower(%s) "
    "AND (document->>'localDate')::date BETWEEN '2030-01-01' AND '2039-12-31' "
    "AND (document->>'minPriceMinor')::integer BETWEEN 1000 AND 2000 "
    "ORDER BY embedding<=>%s LIMIT 60"
)


EXACT_QUERY = QUERY.replace(" LIMIT 60", ",event_id LIMIT 60")


def parameters(vector: list[float], generation: UUID) -> tuple[Any, ...]:
    return Vector(vector), generation, EXCLUDED, "Chisinau", Vector(vector)


async def configure(conn: AsyncConnection[Row], mode: str) -> None:
    await conn.execute("SET enable_bitmapscan=off")
    await conn.execute("SET enable_sort=" + ("on" if mode == "exact" else "off"))
    await conn.execute("SET enable_indexscan=" + ("off" if mode == "exact" else "on"))
    await conn.execute("SET enable_seqscan=" + ("on" if mode == "exact" else "off"))
    if mode != "exact":
        await conn.execute("SELECT set_config('hnsw.ef_search',%s,false)", (mode,))


def diagnostics(rows: list[Row]) -> list[Row]:
    return [
        {
            "id": str(row["id"]),
            "distance": row["distance"],
            "baseEventIndex": (row["id"].int - 1) % 36,
        }
        for row in rows
    ]


def worst_query(index: int, repeat: int, recall: float, ann: list[Row], exact: list[Row]) -> Row:
    return {
        "queryIndex": index,
        "repeat": repeat,
        "recallAt60": recall,
        "ann": diagnostics(ann),
        "exact": diagnostics(exact),
        "annBaseEventCounts": dict(Counter((row["id"].int - 1) % 36 for row in ann)),
        "exactBaseEventCounts": dict(Counter((row["id"].int - 1) % 36 for row in exact)),
    }


async def serving_measurements(
    conn: AsyncConnection[Row], vectors: list[list[float]], generation: UUID
) -> Row:
    recalls, timings = [], []
    worst: Row = {}
    for index, vector in enumerate(vectors):
        for setting in ("enable_indexscan", "enable_seqscan", "enable_bitmapscan", "enable_sort"):
            await conn.execute("SELECT set_config(%s,'on',false)", (setting,))
        started = time.perf_counter()
        async with conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            found = await nearest_candidates(
                conn, generation, Vector(vector), filters(), EXCLUDED, datetime.now(UTC)
            )
        timings.append((time.perf_counter() - started) * 1000)
        await configure(conn, "exact")
        exact = await (
            await conn.execute(EXACT_QUERY, parameters(vector, generation), prepare=False)
        ).fetchall()
        relevant = {row["id"] for row in exact}
        recall = len(set(found) & relevant) / 60
        recalls.append(recall)
        if not worst or recall < worst["recallAt60"]:
            worst = {
                "queryIndex": index,
                "recallAt60": recall,
                "count": len(found),
                "resultIds": [str(id) for id in found],
                "exact": diagnostics(exact),
            }
    return {
        "passed": min(recalls) == 1.0,
        "function": "ranking.nearest_candidates",
        "productionSearchMode": "exact",
        "normalPlannerSettings": True,
        "queries": len(vectors),
        "meanRecallAt60": statistics.mean(recalls),
        "minimumRecallAt60": min(recalls),
        "latencyIncludesTransactionAndSettings": latency_summary(timings),
        "worstQuery": worst,
    }


async def search_measurements(
    conn: AsyncConnection[Row], query_vectors: list[list[float]], generation: UUID
) -> Row:
    plans = {}
    timings: dict[str, list[float]] = {mode: [] for mode in MODES}
    recalls: dict[str, list[float]] = {mode: [] for mode in MODES if mode != "exact"}
    worst: dict[str, Row] = {}
    per_query: dict[str, list[Row]] = {mode: [] for mode in recalls}
    for mode in MODES:
        await configure(conn, mode)
        explained = await (
            await conn.execute(
                "EXPLAIN (FORMAT JSON) " + (EXACT_QUERY if mode == "exact" else QUERY),
                parameters(query_vectors[0], generation),
                prepare=False,
            )
        ).fetchone()
        assert explained is not None
        plan = explained["QUERY PLAN"][0]["Plan"]
        nodes = plan_nodes(plan)
        if mode == "exact" and not any(node["Node Type"] == "Seq Scan" for node in nodes):
            raise BenchmarkError("Exact query did not use a sequential scan")
        if mode != "exact" and not any(
            node.get("Index Name") == "recommendation_vectors" for node in nodes
        ):
            raise BenchmarkError("HNSW query did not use recommendation_vectors")
        plans[mode] = plan
        await (
            await conn.execute(
                EXACT_QUERY if mode == "exact" else QUERY,
                parameters(query_vectors[0], generation),
                prepare=False,
            )
        ).fetchall()
    for index, vector in enumerate(query_vectors):
        for repeat in range(3):
            results = {}
            for mode in MODES if repeat % 2 == 0 else tuple(reversed(MODES)):
                await configure(conn, mode)
                started = time.perf_counter()
                results[mode] = await (
                    await conn.execute(
                        EXACT_QUERY if mode == "exact" else QUERY,
                        parameters(vector, generation),
                        prepare=False,
                    )
                ).fetchall()
                timings[mode].append((time.perf_counter() - started) * 1000)
            relevant = {row["id"] for row in results["exact"]}
            if len(relevant) != 60:
                raise BenchmarkError("Synthetic exact benchmark did not find 60 candidates")
            for mode in recalls:
                found = {row["id"] for row in results[mode]}
                recall = len(found & relevant) / 60
                recalls[mode].append(recall)
                per_query[mode].append(
                    {
                        "queryIndex": index,
                        "repeat": repeat,
                        "recallAt60": recall,
                        "annCount": len(found),
                    }
                )
                if not worst.get(mode) or recall < worst[mode]["recallAt60"]:
                    worst[mode] = worst_query(
                        index, repeat, recall, results[mode], results["exact"]
                    )
    measurements = {
        mode: {
            "passed": min(values) >= MIN_RECALL,
            "meanRecallAt60": statistics.mean(values),
            "minimumRecallAt60": min(values),
            "latency": latency_summary(timings[mode]),
            "worstQuery": worst[mode],
            "queries": per_query[mode],
        }
        for mode, values in recalls.items()
    }
    serving = await serving_measurements(conn, query_vectors, generation)
    return {
        "passed": measurements[str(DIAGNOSTIC_EF_SEARCH)]["passed"] and serving["passed"],
        "productionSearchMode": "exact",
        "experimentalHnswDiagnosticEfSearch": DIAGNOSTIC_EF_SEARCH,
        "gateMinimumRecallAt60": MIN_RECALL,
        "samplesPerMethod": len(timings["exact"]),
        "exactLatency": latency_summary(timings["exact"]),
        "hnsw": measurements,
        "actualServing": serving,
        "plans": plans,
        "preparedPlansDisabledForOracle": True,
        "diagnosticHnswForcedWithSortAndBitmapDisabled": True,
        "productionFilters": [
            "generation",
            "excludedEvent",
            "city",
            "startsAfterNow",
            "localDate",
            "price",
            "tombstones",
        ],
    }


def synthetic_document(index: int) -> SourceDocument:
    return SourceDocument.model_validate(
        {
            "id": str(UUID(int=index + 1)),
            "title": "Synthetic benchmark event",
            "description": "Performance fixture only; no user quality claim",
            "city": "Balti" if index % 20 == 0 else "Chisinau",
            "address": "Synthetic street1",
            "timeZone": "Europe/Chisinau",
            "startsAt": "2031-12-10T16:00:00Z",
            "endsAt": "2031-12-10T18:00:00Z",
            "localDate": "2031-12-10",
            "minPriceMinor": 1200,
            "currency": "EUR",
            "capacity": 100,
            "coverId": None,
        }
    )


async def benchmark(event_vectors: list[list[float]], query_vectors: list[list[float]]) -> Row:
    admin_url = os.environ.get("RECOMMENDATIONS_ADMIN_DATABASE_URL", "")
    application_url = os.environ.get("RECOMMENDATIONS_DATABASE_URL", "")
    verify_local_database_urls(admin_url, application_url)
    inspection = await asyncio.to_thread(
        subprocess.run,
        [
            "docker",
            "inspect",
            "--format",
            "{{.HostConfig.NanoCpus}}",
            "eventflow-local-recommendations-db-1",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    if inspection.stdout.strip() != "1000000000":
        raise BenchmarkError(
            "Benchmark requires the existing database container limited to one CPU"
        )
    name = "eventflow_recommendations_eval_" + uuid4().hex

    def with_database(value: str) -> str:
        return urlunsplit(urlsplit(value)._replace(path="/" + name))

    vectors = performance_vectors(event_vectors)
    generation, other_generation = uuid4(), uuid4()
    async with await AsyncConnection.connect(admin_url, autocommit=True) as admin:
        await admin.execute(
            sql.SQL("CREATE DATABASE {} OWNER recommendations").format(sql.Identifier(name))
        )
        try:
            async with await AsyncConnection.connect(
                with_database(admin_url), autocommit=True
            ) as owner:
                await owner.execute("CREATE EXTENSION vector")
            await migrate(with_database(application_url))
            async with await AsyncConnection.connect(
                with_database(application_url), autocommit=True, row_factory=dict_row
            ) as conn:
                await register_vector_async(conn)
                await conn.execute("SET max_parallel_workers_per_gather=0")
                await conn.execute("SET max_parallel_maintenance_workers=0")
                settings = await (
                    await conn.execute(
                        "SELECT current_setting('max_parallel_workers_per_gather')::integer "
                        "AS gather,"
                        "current_setting('max_parallel_maintenance_workers')::integer "
                        "AS maintenance"
                    )
                ).fetchone()
                assert settings is not None
                await conn.execute("DROP INDEX IF EXISTS recommendation_vectors")
                started = time.perf_counter()
                rows = []
                for index, vector in enumerate(vectors):
                    document = synthetic_document(index)
                    rows.append(
                        (
                            other_generation if index % 37 == 0 else generation,
                            document.id,
                            index + 1,
                            Jsonb(document.model_dump(mode="json", by_alias=True))
                            if index % 101
                            else None,
                            Vector(vector) if index % 101 else None,
                        )
                    )
                async with conn.transaction(), conn.cursor() as cursor:
                    await cursor.executemany(
                        "INSERT INTO recommendation_documents VALUES (%s,%s,%s,%s,%s)", rows
                    )
                insert_seconds = time.perf_counter() - started
                await conn.execute("SET hnsw.iterative_scan=strict_order")
                constructions = []
                for construction in range(2):
                    started = time.perf_counter()
                    await conn.execute(
                        "CREATE INDEX recommendation_vectors ON recommendation_documents "
                        "USING hnsw (embedding vector_cosine_ops) "
                        "WITH (m=32, ef_construction=400)"
                    )
                    index_options = await (
                        await conn.execute(
                            "SELECT reloptions FROM pg_class "
                            "WHERE oid='recommendation_vectors'::regclass"
                        )
                    ).fetchone()
                    assert index_options is not None
                    await conn.execute("ANALYZE recommendation_documents")
                    build_seconds = time.perf_counter() - started
                    measurements = await search_measurements(conn, query_vectors, generation)
                    constructions.append(
                        {
                            "construction": construction + 1,
                            "indexBuildSeconds": build_seconds,
                            "indexParameters": index_options["reloptions"],
                            **measurements,
                        }
                    )
                    await conn.execute("DROP INDEX IF EXISTS recommendation_vectors")
                return {
                    "passed": all(item["passed"] for item in constructions),
                    "syntheticPerformanceOnly": True,
                    "databaseCpuLimit": 1,
                    "description": "Seeded genuine embedding perturbations; not user quality",
                    "rows": len(vectors),
                    "seed": SEED,
                    "dimensions": 384,
                    "topK": 60,
                    "queries": len(query_vectors),
                    "parallelWorkersPerGather": settings["gather"],
                    "parallelMaintenanceWorkers": settings["maintenance"],
                    "insertSeconds": insert_seconds,
                    "constructions": constructions,
                }
        finally:
            await admin.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name))
            )

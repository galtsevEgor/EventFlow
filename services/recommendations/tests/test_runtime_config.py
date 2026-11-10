import json
import re

import pytest

from eventflow_recommendations.config import Config
from eventflow_recommendations.health import projection_is_ready
from eventflow_recommendations.model_contract import DIMENSIONS, MANIFEST_PATH, REPOSITORY_ROOT


def test_model_path_comes_from_manifest_and_is_repository_relative(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    config = Config.read(
        {
            "RECOMMENDATIONS_DATABASE_URL": "postgresql://localhost/recommendations",
            "CATALOG_URL": "http://localhost:4001",
            "OIDC_ISSUER": "http://localhost:18080/realms/eventflow",
            "RECOMMENDATIONS_CLIENT_SECRET": "x" * 32,
            "AMQP_URL": "amqp://localhost",
        }
    )
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    assert config.model_path == (REPOSITORY_ROOT / manifest["localPath"]).resolve()


def test_relative_model_path_override_is_repository_relative():
    config = Config.read(
        {
            "RECOMMENDATIONS_DATABASE_URL": "postgresql://localhost/recommendations",
            "CATALOG_URL": "http://localhost:4001",
            "OIDC_ISSUER": "http://localhost:18080/realms/eventflow",
            "RECOMMENDATIONS_CLIENT_SECRET": "x" * 32,
            "AMQP_URL": "amqp://localhost",
            "RECOMMENDATIONS_MODEL_PATH": "work/custom-model",
        }
    )
    assert config.model_path == (REPOSITORY_ROOT / "work/custom-model").resolve()


def test_dimensions_match_manifest_and_both_pgvector_columns():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    schema = (MANIFEST_PATH.parent / "migrations/001-recommendations.sql").read_text(
        encoding="utf-8"
    )
    assert DIMENSIONS == manifest["dimensions"]
    assert re.findall(r"embedding vector\((\d+)\)", schema) == [
        str(DIMENSIONS),
        str(DIMENSIONS),
    ]


@pytest.mark.integration
async def test_database_vector_columns_match_pinned_model_dimension(projection_pool):
    async with projection_pool.connection() as connection:
        cursor = await connection.execute(
            "SELECT c.relname,format_type(a.atttypid,a.atttypmod) AS type "
            "FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid "
            "WHERE c.relname IN ('recommendation_documents','recommendation_interest_vectors') "
            "AND a.attname='embedding' ORDER BY c.relname"
        )
        assert [row["type"] for row in await cursor.fetchall()] == [
            f"vector({DIMENSIONS})",
            f"vector({DIMENSIONS})",
        ]


def test_projection_readiness_requires_recent_heartbeat_strictly_under_45_seconds():
    assert projection_is_ready(True, 44.999)
    assert not projection_is_ready(True, 45)
    assert not projection_is_ready(True, None)
    assert not projection_is_ready(False, 1)

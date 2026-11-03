from __future__ import annotations

import time
from contextlib import asynccontextmanager
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from test_public_api import FakeCatalog, assert_private, config, document

from eventflow_recommendations.app import create_app
from eventflow_recommendations.auth import JwtIdentity

PREFIX = "/api/v1/recommendations"


@pytest.fixture(scope="module")
def private_signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def authorization(key, actor, **overrides):
    now = int(time.time())
    claims = {
        "iss": config().issuer,
        "sub": str(actor),
        "aud": "eventflow-recommendations",
        "azp": "eventflow-bff",
        "iat": now,
        "exp": now + 300,
        "email": "synthetic-buyer@example.test",
        "email_verified": True,
        **overrides,
    }
    return {
        "authorization": "Bearer "
        + jwt.encode(claims, key, algorithm="RS256", headers={"kid": "private-api-test"})
    }


@asynccontextmanager
async def private_client(pool, catalog, key, *, issuer_failure=False):
    calls = []

    async def jwks(request):
        calls.append(request)
        assert str(request.url) == config().issuer + "/protocol/openid-connect/certs"
        assert "authorization" not in request.headers
        if issuer_failure:
            raise httpx.ConnectError("postgresql://private-user:password@internal/private-db")
        entry = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
        return httpx.Response(
            200,
            json={
                "keys": [
                    {
                        **entry,
                        "kid": "private-api-test",
                        "alg": "RS256",
                        "use": "sig",
                    }
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(jwks)) as keys:
        identity = JwtIdentity(config(), keys)
        app = create_app(config(), service_pool=pool, catalog=catalog, identity=identity)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://test",
        ) as client:
            yield client, calls


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    assert_private(response)
    assert response.json()["code"] == code
    assert set(response.json()) == {"code", "message", "requestId", "retryable"}


@pytest.mark.integration
class TestPrivateApi:
    async def test_private_api_interests_are_public_and_nonpersonal(
        self, projection_pool, private_signing_key
    ):
        async with private_client(projection_pool, FakeCatalog(), private_signing_key) as (
            http,
            keys,
        ):
            response = await http.get(PREFIX + "/interests")
        assert response.status_code == 200
        assert_private(response)
        interests = response.json()["interests"]
        assert len(interests) == 12 and len({item["id"] for item in interests}) == 12
        assert all(set(item) == {"id", "title"} for item in interests)
        assert not keys

    @pytest.mark.parametrize(
        "method,suffix,body",
        [
            ("GET", "/profile", None),
            ("PUT", "/profile", {"revision": 0, "interests": []}),
            ("PUT", "/favorites/" + str(uuid4()), None),
            ("DELETE", "/favorites/" + str(uuid4()), None),
            ("GET", "/me", None),
        ],
    )
    async def test_private_api_anonymous_rejected_before_source_or_jwks(
        self, projection_pool, private_signing_key, method, suffix, body
    ):
        catalog = FakeCatalog()
        async with private_client(projection_pool, catalog, private_signing_key) as (http, keys):
            response = await http.request(method, PREFIX + suffix, json=body)
        assert_error(response, 401, "UNAUTHENTICATED")
        assert not keys and not catalog.hydrated and not catalog.upcoming_queries

    async def test_private_api_machine_jwt_and_unverified_user_rejected(
        self, projection_pool, private_signing_key
    ):
        actor = uuid4()
        async with private_client(projection_pool, FakeCatalog(), private_signing_key) as (
            http,
            keys,
        ):
            machine = authorization(private_signing_key, actor, azp="eventflow-recommendations")
            denied = await http.get(PREFIX + "/profile", headers=machine)
            assert_error(denied, 401, "UNAUTHENTICATED")
            unverified = authorization(private_signing_key, actor, email_verified=False)
            denied_email = await http.get(PREFIX + "/profile", headers=unverified)
            assert_error(denied_email, 403, "EMAIL_UNVERIFIED")
        assert len(keys) == 1

    async def test_private_api_verified_actor_isolation_and_unknown_actor_body_rejected(
        self, projection_pool, private_signing_key
    ):
        actor_a, actor_b = uuid4(), uuid4()
        event = document()
        headers_a = authorization(private_signing_key, actor_a)
        headers_b = authorization(private_signing_key, actor_b)
        async with private_client(projection_pool, FakeCatalog([event]), private_signing_key) as (
            http,
            keys,
        ):
            saved = await http.put(
                PREFIX + "/profile", headers=headers_a, json={"revision": 0, "interests": ["jazz"]}
            )
            assert saved.status_code == 200
            assert_private(saved)
            added = await http.put(PREFIX + f"/favorites/{event.id}", headers=headers_a)
            assert added.status_code == 200
            assert_private(added)
            assert added.json()["revision"] == 2
            assert added.json()["favorites"][0]["eventId"] == str(event.id)
            other = await http.get(PREFIX + "/profile", headers=headers_b)
            assert other.status_code == 200
            assert other.json() == {"revision": 0, "interests": [], "favorites": []}
            forged = await http.put(
                PREFIX + "/profile",
                headers=headers_b,
                json={
                    "revision": 0,
                    "interests": ["rock"],
                    "actor": str(actor_a),
                },
            )
            assert_error(forged, 422, "VALIDATION_FAILED")
            removed = await http.delete(PREFIX + f"/favorites/{event.id}", headers=headers_b)
            assert removed.status_code == 200 and removed.json()["revision"] == 0
            unchanged = await http.get(PREFIX + "/profile", headers=headers_a)
            assert unchanged.json() == added.json()
        assert len(keys) == 1

    async def test_private_api_revision_conflict_and_lost_ack_retry(
        self, projection_pool, private_signing_key
    ):
        headers = authorization(private_signing_key, uuid4())
        async with private_client(projection_pool, FakeCatalog(), private_signing_key) as (http, _):
            first = await http.put(
                PREFIX + "/profile",
                headers=headers,
                json={"revision": 0, "interests": ["theatre", "jazz"]},
            )
            assert first.status_code == 200 and first.json()["revision"] == 1
            replay = await http.put(
                PREFIX + "/profile",
                headers=headers,
                json={"revision": 0, "interests": ["jazz", "theatre"]},
            )
            assert replay.status_code == 200 and replay.json() == first.json()
            conflict = await http.put(
                PREFIX + "/profile", headers=headers, json={"revision": 0, "interests": ["rock"]}
            )
            assert_error(conflict, 409, "PROFILE_CHANGED")
            assert (await http.get(PREFIX + "/profile", headers=headers)).json() == first.json()
            invalid = await http.put(
                PREFIX + "/profile",
                headers=headers,
                json={"revision": 1, "interests": ["unknown-interest"]},
            )
            assert_error(invalid, 422, "VALIDATION_FAILED")

    async def test_private_api_favorites_replay_current_unavailable_placeholder_and_delete(
        self, projection_pool, private_signing_key
    ):
        event = document()
        catalog = FakeCatalog([event])
        headers = authorization(private_signing_key, uuid4())
        async with private_client(projection_pool, catalog, private_signing_key) as (http, _):
            first = await http.put(PREFIX + f"/favorites/{event.id}", headers=headers)
            assert first.status_code == 200 and first.json()["revision"] == 1
            assert_private(first)
            repeat = await http.put(PREFIX + f"/favorites/{event.id}", headers=headers)
            assert repeat.status_code == 200 and repeat.json() == first.json()
            del catalog.documents[event.id]
            hidden = await http.get(PREFIX + "/profile", headers=headers)
            assert hidden.status_code == 200
            assert hidden.json()["favorites"] == [{"eventId": str(event.id), "event": None}]
            assert event.title not in hidden.text
            deleted = await http.delete(PREFIX + f"/favorites/{event.id}", headers=headers)
            assert deleted.status_code == 200 and deleted.json()["revision"] == 2
            assert deleted.json()["favorites"] == []
            duplicate = await http.delete(PREFIX + f"/favorites/{event.id}", headers=headers)
            assert duplicate.status_code == 200 and duplicate.json() == deleted.json()
            absent = await http.put(PREFIX + f"/favorites/{event.id}", headers=headers)
            assert_error(absent, 404, "NOT_FOUND")

    async def test_private_api_me_filters_warming_and_new_user_labels(
        self, projection_pool, private_signing_key
    ):
        event = document()
        catalog = FakeCatalog([event])
        headers = authorization(private_signing_key, uuid4())
        async with private_client(projection_pool, catalog, private_signing_key) as (http, _):
            fresh = await http.get(PREFIX + "/me", headers=headers)
            assert fresh.status_code == 200 and fresh.json()["mode"] == "upcoming"
            assert fresh.json()["degraded"] is False
            saved = await http.put(
                PREFIX + "/profile", headers=headers, json={"revision": 0, "interests": ["jazz"]}
            )
            assert saved.status_code == 200
            selected = await http.get(
                PREFIX + "/me",
                headers=headers,
                params={
                    "city": "Chisinau",
                    "from": event.local_date.isoformat(),
                    "to": event.local_date.isoformat(),
                    "minPriceMinor": "1200",
                    "maxPriceMinor": "1300",
                    "limit": "1",
                },
            )
            assert selected.status_code == 200
            assert_private(selected)
            assert selected.json()["mode"] == "upcoming" and selected.json()["degraded"] is True
            assert selected.json()["items"][0]["reason"] == "UPCOMING"
            filters, excluded = catalog.upcoming_queries[-1]
            assert filters.city == "Chisinau" and filters.limit == 1 and excluded == []
            assert filters.from_date == filters.to_date == event.local_date
            assert filters.min_price_minor == 1200 and filters.max_price_minor == 1300
            invalid = await http.get(PREFIX + "/me?actor=" + str(uuid4()), headers=headers)
            assert_error(invalid, 422, "VALIDATION_FAILED")

    async def test_private_api_failures_sanitized_and_no_store(
        self, projection_pool, private_signing_key
    ):
        actor, event = uuid4(), document()
        catalog = FakeCatalog(
            failure=RuntimeError("Bearer private-token password postgresql://private")
        )
        headers = authorization(private_signing_key, actor)
        async with private_client(projection_pool, catalog, private_signing_key) as (http, _):
            response = await http.put(PREFIX + f"/favorites/{event.id}", headers=headers)
            assert_error(response, 503, "RECOMMENDATIONS_UNAVAILABLE")
            assert all(
                value not in response.text for value in ["private-token", "password", "postgresql"]
            )
            catalog.failure = None
            profile = await http.get(PREFIX + "/profile", headers=headers)
            assert profile.json() == {"revision": 0, "interests": [], "favorites": []}
        async with private_client(
            projection_pool, FakeCatalog(), private_signing_key, issuer_failure=True
        ) as (http, keys):
            response = await http.get(PREFIX + "/profile", headers=headers)
            assert_error(response, 503, "IDENTITY_UNAVAILABLE")
            assert all(
                value not in response.text for value in ["private-user", "password", "internal"]
            )
            assert len(keys) == 1

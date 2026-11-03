import asyncio
import time
from uuid import uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from test_public_api import config

from eventflow_recommendations.auth import JwtIdentity
from eventflow_recommendations.errors import ApiError


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def claims():
    return {
        "iss": config().issuer,
        "sub": str(uuid4()),
        "aud": "eventflow-recommendations",
        "azp": "eventflow-bff",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
        "email": "buyer@example.test",
        "email_verified": True,
    }


def signed(key, body=None, kid="one"):
    return "Bearer " + jwt.encode(body or claims(), key, algorithm="RS256", headers={"kid": kid})


def identity(key, *, failure=False):
    calls = []

    async def transport(request):
        calls.append(request)
        assert str(request.url) == config().issuer + "/protocol/openid-connect/certs"
        if failure:
            raise httpx.ConnectError("private diagnostic credentials")
        entry = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
        return httpx.Response(
            200, json={"keys": [{**entry, "kid": "one", "use": "sig", "alg": "RS256"}]}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    return JwtIdentity(config(), client), client, calls


async def test_verified_jwt_cache_and_singleflight(signing_key):
    users, http, calls = identity(signing_key)
    body = claims()
    async with http:
        actors = await asyncio.gather(*(users.actor(signed(signing_key, body)) for _ in range(20)))
    assert {str(actor) for actor in actors} == {body["sub"]}
    assert len(calls) == 1


@pytest.mark.parametrize(
    "field,value,status",
    [
        ("iss", "https://untrusted.invalid", 401),
        ("aud", "eventflow-catalog", 401),
        ("azp", "eventflow-recommendations", 401),
        ("exp", 1, 401),
        ("iat", int(time.time()) + 3600, 401),
        ("iat", "1", 401),
        ("sub", "not-uuid", 401),
        ("email", "not-email", 401),
        ("email_verified", False, 403),
        ("email_verified", "true", 403),
    ],
)
async def test_untrusted_identity_claims_rejected(signing_key, field, value, status):
    users, http, _ = identity(signing_key)
    body = {**claims(), field: value}
    async with http:
        with pytest.raises(ApiError) as error:
            await users.actor(signed(signing_key, body))
    assert error.value.status == status


@pytest.mark.parametrize(
    "authorization", [None, "Bearer broken", "Basic credentials", "Bearer " + "a" * 33000]
)
async def test_malformed_credentials_do_not_fetch_keys(signing_key, authorization):
    users, http, calls = identity(signing_key)
    async with http:
        with pytest.raises(ApiError) as error:
            await users.actor(authorization)
    assert error.value.status == 401 and not calls


async def test_algorithm_signature_and_unknown_kid_rejected(signing_key):
    users, http, calls = identity(signing_key)
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    tokens = [
        "Bearer " + jwt.encode(claims(), "x" * 32, algorithm="HS256", headers={"kid": "one"}),
        signed(other),
        signed(signing_key, kid="unknown"),
    ]
    async with http:
        for token in tokens:
            with pytest.raises(ApiError) as error:
                await users.actor(token)
            assert error.value.status == 401
    assert len(calls) == 1


async def test_identity_outage_is_retryable_and_refresh_is_bounded(signing_key):
    users, http, calls = identity(signing_key, failure=True)
    async with http:
        for _ in range(3):
            with pytest.raises(ApiError) as error:
                await users.actor(signed(signing_key))
            assert error.value.status == 503
            assert "private" not in str(error.value)
    assert len(calls) == 1

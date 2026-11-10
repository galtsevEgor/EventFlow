import asyncio
import re
import time
from uuid import UUID

import httpx
import jwt

from .config import Config
from .errors import ApiError
from .policies import (
    IDENTITY_JWKS_CACHE_SECONDS,
    IDENTITY_JWKS_MAX_KEYS,
    IDENTITY_KEY_ID_MAX_LENGTH,
    IDENTITY_REFRESH_FAILURE_COOLDOWN_SECONDS,
    IDENTITY_TOKEN_MAX_LENGTH,
)


class JwtIdentity:
    def __init__(self, config: Config, client: httpx.AsyncClient | None = None):
        self.issuer = config.issuer
        self.client = client or httpx.AsyncClient(
            timeout=config.identity_timeout, follow_redirects=False
        )
        self.owns_client = client is None
        self.keys: dict[str, jwt.PyJWK] = {}
        self.refreshed = float("-inf")
        self.unavailable = False
        self.lock = asyncio.Lock()

    async def close(self) -> None:
        if self.owns_client:
            await self.client.aclose()

    async def key(self, kid: str) -> jwt.PyJWK:
        async with self.lock:
            age = time.monotonic() - self.refreshed
            if (
                kid in self.keys and age < IDENTITY_JWKS_CACHE_SECONDS
            ) or age < IDENTITY_REFRESH_FAILURE_COOLDOWN_SECONDS:
                if self.unavailable:
                    raise ApiError(
                        503, "IDENTITY_UNAVAILABLE", "Проверка входа временно недоступна."
                    )
                if kid not in self.keys:
                    raise unauthenticated()
                return self.keys[kid]
            # Record failed refreshes too: an unavailable issuer cannot cause a request storm.
            self.refreshed = time.monotonic()
            try:
                response = await self.client.get(self.issuer + "/protocol/openid-connect/certs")
                response.raise_for_status()
                entries = response.json()["keys"]
                if not isinstance(entries, list) or not 1 <= len(entries) <= IDENTITY_JWKS_MAX_KEYS:
                    raise ValueError("Invalid signing key set")
                keys = {}
                for entry in entries:
                    if entry.get("kty") != "RSA" or entry.get("use", "sig") != "sig":
                        continue
                    name = entry["kid"]
                    if (
                        not isinstance(name, str)
                        or not 1 <= len(name) <= IDENTITY_KEY_ID_MAX_LENGTH
                        or name in keys
                    ):
                        raise ValueError("Invalid signing key identity")
                    if entry.get("alg", "RS256") != "RS256":
                        continue
                    keys[name] = jwt.PyJWK.from_dict(entry, algorithm="RS256")
                if not keys:
                    raise ValueError("No signing keys")
                self.keys = keys
                self.unavailable = False
            except (httpx.HTTPError, ValueError, KeyError, TypeError, jwt.PyJWTError) as error:
                self.keys = {}
                self.unavailable = True
                raise ApiError(
                    503, "IDENTITY_UNAVAILABLE", "Проверка входа временно недоступна."
                ) from error
            if kid not in self.keys:
                raise unauthenticated()
            return self.keys[kid]

    async def actor(self, authorization: str | None) -> UUID:
        if (
            not authorization
            or len(authorization) > IDENTITY_TOKEN_MAX_LENGTH
            or not re.fullmatch(
                r"Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", authorization
            )
        ):
            raise unauthenticated()
        token = authorization[7:]
        try:
            header = jwt.get_unverified_header(token)
            kid = header.get("kid")
            if (
                header.get("alg") != "RS256"
                or not isinstance(kid, str)
                or not 1 <= len(kid) <= IDENTITY_KEY_ID_MAX_LENGTH
            ):
                raise unauthenticated()
            key = await self.key(kid)
            claims = jwt.decode(
                token,
                key.key,
                algorithms=["RS256"],
                audience="eventflow-recommendations",
                issuer=self.issuer,
                options={"require": ["iss", "sub", "aud", "iat", "exp"]},
            )
            if (
                claims.get("azp") != "eventflow-bff"
                or any(type(claims[field]) is not int for field in ("iat", "exp"))
                or not isinstance(claims.get("email"), str)
                or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", claims["email"])
            ):
                raise unauthenticated()
            actor = UUID(claims["sub"])
            if claims.get("email_verified") is not True:
                raise ApiError(403, "EMAIL_UNVERIFIED", "Подтвердите email.")
            return actor
        except (jwt.PyJWTError, ValueError, TypeError, KeyError) as error:
            raise unauthenticated() from error


def unauthenticated() -> ApiError:
    return ApiError(401, "UNAUTHENTICATED", "Войдите в аккаунт.")

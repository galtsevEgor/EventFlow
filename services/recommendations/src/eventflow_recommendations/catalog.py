"""Authenticated, bounded Catalog transport. Redirects and malformed feeds fail closed."""

from __future__ import annotations

import asyncio
import time
from typing import Any
from uuid import UUID

import httpx
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from pydantic import BaseModel, ConfigDict, Field

from .config import Config
from .contracts import RecommendationFilters, SourceDocument, SourcePage


class SourceChanged(Exception):
    """Catalog no longer contains the requested source horizon."""


class InvalidSource(ValueError):
    """A permanent source contract violation."""


class ReconcilePage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    next: UUID | None


class TokenResponse(BaseModel):
    access_token: str = Field(min_length=1, max_length=32768)
    expires_in: int = Field(strict=True, ge=1, le=86400)
    token_type: str


class DocumentPage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    events: list[SourceDocument] = Field(max_length=100)


class CatalogClient:
    def __init__(self, config: Config, client: httpx.AsyncClient | None = None) -> None:
        self.config = config
        self.client = client or httpx.AsyncClient(timeout=5, follow_redirects=False)
        self._owns_client = client is None
        self._token = ""
        self._expires = 0.0
        self._token_lock = asyncio.Lock()

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    async def _credentials(self) -> str:
        async with self._token_lock:
            if self._token and time.monotonic() < self._expires:
                return self._token
            response = await self.client.post(
                self.config.issuer + "/protocol/openid-connect/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": "eventflow-recommendations",
                    "client_secret": self.config.client_secret,
                },
                timeout=5,
                follow_redirects=False,
            )
            if response.status_code != 200:
                raise RuntimeError("Catalog credentials unavailable")
            token = TokenResponse.model_validate(response.json())
            if token.token_type.lower() != "bearer":
                raise InvalidSource("Invalid token type")
            self._token, self._expires = (
                token.access_token,
                time.monotonic() + max(0.0, token.expires_in - min(30, token.expires_in / 2)),
            )
            return self._token

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        token = await self._credentials()
        headers = {"authorization": "Bearer " + token}
        TraceContextTextMapPropagator().inject(headers)
        response = await self.client.request(
            method,
            self.config.catalog_url + path,
            headers=headers,
            timeout=5,
            follow_redirects=False,
            **kwargs,
        )
        if response.status_code == 409:
            raise SourceChanged("Catalog source changed")
        if response.status_code == 401:
            self._token = ""
        if response.status_code != 200:
            raise RuntimeError("Catalog unavailable")
        return response.json()

    async def read(self, after: int, through: int | None = None) -> SourcePage:
        params = {"after": str(after), "limit": "100"}
        if through is not None:
            params["through"] = str(through)
        page = SourcePage.model_validate(
            await self._request("GET", "/internal/search/changes", params=params)
        )
        validate_page(page, after, through)
        return page

    async def reconcile(self) -> None:
        after: UUID | None = None
        for _ in range(10000):
            body: dict[str, Any] = {"limit": 100}
            if after:
                body["after"] = str(after)
            page = ReconcilePage.model_validate(
                await self._request("POST", "/internal/search/reconcile", json=body)
            )
            if page.next is None:
                return
            if after is not None and page.next.int <= after.int:
                raise InvalidSource("Invalid reconcile cursor")
            after = page.next
        raise InvalidSource("Catalog reconciliation limit reached")

    async def hydrate(self, ids: list[UUID]) -> list[SourceDocument]:
        if len(ids) > 100 or len(set(ids)) != len(ids):
            raise ValueError("Hydration accepts up to100 unique IDs")
        if not ids:
            return []
        result = await self._request(
            "POST", "/internal/recommendations/hydrate", json={"ids": [str(i) for i in ids]}
        )
        documents = DocumentPage.model_validate(result).events
        if len(documents) > len(ids):
            raise InvalidSource("Invalid hydration response")
        found = [document.id for document in documents]
        if len(set(found)) != len(found) or not set(found).issubset(ids):
            raise InvalidSource("Hydration identity mismatch")
        return documents

    async def upcoming(
        self, filters: RecommendationFilters, exclude: list[UUID]
    ) -> list[SourceDocument]:
        result = await self._request(
            "POST",
            "/internal/recommendations/upcoming",
            json={
                **filters.model_dump(mode="json", by_alias=True, exclude_none=True),
                "exclude": [str(item) for item in exclude],
            },
        )
        documents = DocumentPage.model_validate(result).events
        if len(documents) > filters.limit or len({item.id for item in documents}) != len(documents):
            raise InvalidSource("Invalid upcoming response")
        return documents


def validate_page(page: SourcePage, after: int, through: int | None = None) -> None:
    previous = after
    if page.through < after or (through is not None and page.through != through):
        raise InvalidSource("Invalid source horizon")
    for change in page.changes:
        if change.position <= previous or change.position > page.through:
            raise InvalidSource("Invalid feed order")
        if change.document and change.document.id != change.event_id:
            raise InvalidSource("Source identity mismatch")
        previous = change.position
    if (
        page.next != previous
        or page.next > page.through
        or (not page.changes and after < page.through)
    ):
        raise InvalidSource("Invalid feed cursor")

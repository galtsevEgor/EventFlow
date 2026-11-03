from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg import Error as DatabaseError
from psycopg_pool import PoolTimeout
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from .auth import JwtIdentity
from .catalog import CatalogClient
from .config import Config
from .contracts import (
    InterestOption,
    InterestOptions,
    PreferenceInput,
    ProfileState,
    RecommendationError,
    RecommendationFilters,
    RecommendationPage,
)
from .database import Pool, pool
from .errors import ApiError
from .interests import INTERESTS
from .profiles import Profiles
from .ranking import Recommendations


def create_app(
    config: Config,
    service_pool: Pool | None = None,
    catalog: CatalogClient | None = None,
    identity: JwtIdentity | None = None,
) -> FastAPI:
    database = service_pool or pool(config.database_url)
    source = catalog or CatalogClient(config)
    recommendations = Recommendations(database, source)
    profiles = Profiles(database, source)
    users = identity or JwtIdentity(config)
    bearer = HTTPBearer(auto_error=False)

    async def actor(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ) -> UUID:
        return await users.actor(
            f"{credentials.scheme} {credentials.credentials}" if credentials else None
        )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if service_pool is None:
            await database.open()
        try:
            yield
        finally:
            if identity is None:
                await users.close()
            if catalog is None:
                await source.close()
            if service_pool is None:
                await database.close()

    app = FastAPI(title="EventFlow Recommendations API", version="1.0.0", lifespan=lifespan)

    @app.middleware("http")
    async def privacy_headers(request: Request, call_next: RequestResponseEndpoint) -> Response:
        try:
            request.state.request_id = str(UUID(request.headers.get("x-request-id", "")))
        except ValueError:
            request.state.request_id = str(uuid4())
        try:
            response = await call_next(request)
        except Exception as error:
            response = await unavailable(request, error)
        response.headers["cache-control"] = "no-store"
        response.headers["x-request-id"] = request.state.request_id
        return response

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, error: ApiError) -> JSONResponse:
        return failure(_request, error.status, error.code, str(error))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return failure(_request, 422, "VALIDATION_FAILED", "Проверьте параметры подборки.")

    @app.exception_handler(Exception)
    async def unavailable(_request: Request, _error: Exception) -> JSONResponse:
        return failure(
            _request, 503, "RECOMMENDATIONS_UNAVAILABLE", "Подборка временно недоступна."
        )

    def failure(request: Request, status: int, code: str, message: str) -> JSONResponse:
        request_id = str(getattr(request.state, "request_id", uuid4()))
        return JSONResponse(
            status_code=status,
            content=RecommendationError(
                code=code,
                message=message,
                requestId=request_id,
                retryable=status >= 500 or status == 429,
            ).model_dump(),
            headers={"cache-control": "no-store", "x-request-id": request_id},
        )

    @app.get("/health/live", include_in_schema=False)
    async def live() -> dict[str, str]:
        return {"status": "ok", "service": "recommendations"}

    @app.get("/health/ready", include_in_schema=False)
    async def ready() -> JSONResponse:
        try:
            async with database.connection() as connection:
                cursor = await connection.execute(
                    "SELECT active_generation IS NOT NULL AND heartbeat>"
                    "clock_timestamp()-interval '45 seconds' AS ready "
                    "FROM recommendation_projection WHERE id=1"
                )
                state = await cursor.fetchone()
            available = bool(state and state["ready"])
        except (DatabaseError, PoolTimeout):
            available = False
        return JSONResponse(
            status_code=200 if available else 503,
            content={"status": "ready" if available else "warming", "service": "recommendations"},
        )

    @app.get(
        "/api/v1/events/{id}/similar",
        response_model=RecommendationPage,
        operation_id="similarEvents",
        responses={code: {"model": RecommendationError} for code in (404, 422, 503)},
        openapi_extra={"security": []},
    )
    async def similar(
        id: UUID, filters: Annotated[RecommendationFilters, Query()]
    ) -> RecommendationPage:
        return await recommendations.similar(id, filters)

    errors: dict[int | str, dict[str, Any]] = {
        code: {"model": RecommendationError} for code in (401, 403, 404, 409, 422, 503)
    }

    @app.get(
        "/api/v1/recommendations/interests",
        response_model=InterestOptions,
        operation_id="recommendationInterests",
        openapi_extra={"security": []},
    )
    async def interests() -> InterestOptions:
        return InterestOptions(
            interests=[InterestOption(id=item.id, title=item.title) for item in INTERESTS]
        )

    @app.get(
        "/api/v1/recommendations/profile",
        response_model=ProfileState,
        operation_id="recommendationProfile",
        responses=errors,
    )
    async def profile(user: Annotated[UUID, Depends(actor)]) -> ProfileState:
        return await profiles.get(user)

    @app.put(
        "/api/v1/recommendations/profile",
        response_model=ProfileState,
        operation_id="saveRecommendationInterests",
        responses=errors,
    )
    async def save_profile(
        body: PreferenceInput, user: Annotated[UUID, Depends(actor)]
    ) -> ProfileState:
        return await profiles.save_interests(user, body.revision, body.interests)

    @app.put(
        "/api/v1/recommendations/favorites/{id}",
        response_model=ProfileState,
        operation_id="addRecommendationFavorite",
        responses=errors,
    )
    async def add_favorite(id: UUID, user: Annotated[UUID, Depends(actor)]) -> ProfileState:
        return await profiles.favorite(user, id, True)

    @app.delete(
        "/api/v1/recommendations/favorites/{id}",
        response_model=ProfileState,
        operation_id="removeRecommendationFavorite",
        responses=errors,
    )
    async def remove_favorite(id: UUID, user: Annotated[UUID, Depends(actor)]) -> ProfileState:
        return await profiles.favorite(user, id, False)

    @app.get(
        "/api/v1/recommendations/me",
        response_model=RecommendationPage,
        operation_id="personalRecommendations",
        responses=errors,
    )
    async def personal(
        filters: Annotated[RecommendationFilters, Query()], user: Annotated[UUID, Depends(actor)]
    ) -> RecommendationPage:
        return await profiles.feed(user, filters)

    return app

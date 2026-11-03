from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg import Error as DatabaseError
from psycopg_pool import PoolTimeout
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import Response

from .catalog import CatalogClient
from .config import Config
from .contracts import RecommendationError, RecommendationFilters, RecommendationPage
from .database import Pool, pool
from .errors import ApiError
from .ranking import Recommendations


def create_app(
    config: Config, service_pool: Pool | None = None, catalog: CatalogClient | None = None
) -> FastAPI:
    database = service_pool or pool(config.database_url)
    source = catalog or CatalogClient(config)
    recommendations = Recommendations(database, source)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if service_pool is None:
            await database.open()
        try:
            yield
        finally:
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

    return app

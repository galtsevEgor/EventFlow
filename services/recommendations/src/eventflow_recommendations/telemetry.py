"""Optional OTLP signals with fixed labels and no user, event, query or credential data."""

import os
import re
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.metrics import NoOpMeterProvider
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from .database import Pool
from .health import projection_is_ready

MISSING_HEARTBEAT_AGE_SECONDS = 1e9


def endpoint(value: str) -> str:
    url = urlsplit(value)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        raise ValueError("Invalid telemetry endpoint")
    return value


class Telemetry:
    def __init__(
        self, component: Literal["api", "worker"], env: Mapping[str, str] | None = None
    ) -> None:
        values = os.environ if env is None else env
        self.traces: TracerProvider | None = None
        self.metrics: MeterProvider | None = None
        self.labels = {"component": component}
        if values.get("EVENTFLOW_TELEMETRY_ENABLED") == "true":
            ratio = float(values.get("EVENTFLOW_TRACE_SAMPLE_RATIO", "0.1"))
            if not 0 <= ratio <= 1:
                raise ValueError("Invalid trace sampling ratio")
            environment = values.get("EVENTFLOW_ENVIRONMENT", "local")
            if environment not in ("local", "test", "staging", "demo", "recovery"):
                raise ValueError("Invalid telemetry environment")
            build = values.get("EVENTFLOW_BUILD_ID", "")
            resource = Resource.create(
                {
                    "service.name": "recommendations",
                    "service.instance.id": str(uuid4()),
                    "service.version": build if re.fullmatch(r"[a-f0-9]{40}", build) else "dev",
                    "deployment.environment.name": environment,
                }
            )
            traces_url = endpoint(
                values.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:14318/v1/traces")
            )
            metrics_url = endpoint(
                values.get(
                    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
                    traces_url.removesuffix("/v1/traces") + "/v1/metrics",
                )
            )
            self.traces = TracerProvider(
                resource=resource, sampler=ParentBased(TraceIdRatioBased(ratio))
            )
            self.traces.add_span_processor(
                BatchSpanProcessor(
                    OTLPSpanExporter(endpoint=traces_url, timeout=1),
                    max_queue_size=128,
                    max_export_batch_size=32,
                    schedule_delay_millis=1000,
                )
            )
            self.metrics = MeterProvider(
                resource=resource,
                views=[
                    View(
                        instrument_name=name,
                        aggregation=ExplicitBucketHistogramAggregation(
                            [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
                        ),
                    )
                    for name in (
                        "eventflow_recommendations_request_duration",
                        "eventflow_recommendations_sync_duration",
                    )
                ],
                metric_readers=[
                    PeriodicExportingMetricReader(
                        OTLPMetricExporter(endpoint=metrics_url, timeout=1),
                        export_interval_millis=5000,
                        export_timeout_millis=1500,
                    )
                ],
            )
        self.tracer = (self.traces or trace.NoOpTracerProvider()).get_tracer(
            "eventflow.recommendations"
        )
        meter = (self.metrics or NoOpMeterProvider()).get_meter("eventflow.recommendations")
        self.requests = meter.create_counter("eventflow_recommendations_requests", unit="1")
        self.duration = meter.create_histogram(
            "eventflow_recommendations_request_duration", unit="s"
        )
        self.results = meter.create_counter("eventflow_recommendations_results", unit="1")
        self.projection_up = meter.create_gauge("eventflow_recommendations_projection_up", unit="1")
        self.ready = meter.create_gauge("eventflow_recommendations_ready", unit="1")
        self.gap = meter.create_gauge("eventflow_recommendations_cursor_gap", unit="1")
        self.age = meter.create_gauge("eventflow_recommendations_sync_age", unit="s")
        self.sync_duration = meter.create_histogram(
            "eventflow_recommendations_sync_duration", unit="s"
        )

    @contextmanager
    def span(
        self, operation: Literal["http", "projection", "model_load"], parent: str = ""
    ) -> Iterator[trace.Span]:
        context = (
            TraceContextTextMapPropagator().extract({"traceparent": parent}) if parent else None
        )
        with self.tracer.start_as_current_span(
            "recommendations." + operation,
            context=context,
            attributes=self.labels,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                yield span
            except BaseException:
                span.set_status(trace.Status(trace.StatusCode.ERROR))
                raise

    def http(self, operation: str, status: int, started: float) -> None:
        # Paths from route templates only; never arbitrary caller URLs.
        allowed = {
            "similarEvents",
            "recommendationInterests",
            "recommendationProfile",
            "saveRecommendationInterests",
            "addRecommendationFavorite",
            "removeRecommendationFavorite",
            "personalRecommendations",
        }
        labels = {
            **self.labels,
            "operation": operation if operation in allowed else "other",
            "status_class": str(status // 100) + "xx",
        }
        self.requests.add(1, labels)
        self.duration.record(time.perf_counter() - started, labels)

    def result(self, mode: str, degraded: bool) -> None:
        self.results.add(
            1,
            {
                **self.labels,
                "mode": mode if mode in ("similar", "personal", "upcoming") else "other",
                "degraded": degraded,
            },
        )

    async def projection(self, database: Pool, success: bool, started: float) -> None:
        if self.metrics is None:
            return
        self.projection_up.set(int(success), self.labels)
        self.sync_duration.record(time.perf_counter() - started, self.labels)
        try:
            async with database.connection() as connection:
                row = await (
                    await connection.execute(
                        "SELECT active_generation IS NOT NULL AS active,through-cursor AS gap, "
                        "CASE WHEN heartbeat IS NULL THEN NULL ELSE "
                        "GREATEST(0,extract(epoch FROM clock_timestamp()-heartbeat)) END AS age "
                        "FROM recommendation_projection WHERE id=1"
                    )
                ).fetchone()
            self.ready.set(
                int(projection_is_ready(bool(row and row["active"]), row["age"] if row else None)),
                self.labels,
            )
            if row:
                self.gap.set(max(0, row["gap"]), self.labels)
                age = row["age"]
                self.age.set(
                    float(age) if age is not None else MISSING_HEARTBEAT_AGE_SECONDS,
                    self.labels,
                )
        except Exception:
            self.ready.set(0, self.labels)

    def close(self) -> None:
        if self.metrics:
            self.metrics.shutdown(timeout_millis=2000)
        if self.traces:
            self.traces.shutdown()

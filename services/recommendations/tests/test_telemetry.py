import base64
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

import httpx
import pytest
from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from test_public_api import FakeCatalog, config

from eventflow_recommendations.app import create_app
from eventflow_recommendations.telemetry import Telemetry, endpoint


@pytest.fixture
def collector():
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received.append((self.path, self.rfile.read(int(self.headers["content-length"]))))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    signals = Telemetry(
        "api",
        {
            "EVENTFLOW_TELEMETRY_ENABLED": "true",
            "EVENTFLOW_TRACE_SAMPLE_RATIO": "1",
            "EVENTFLOW_ENVIRONMENT": "test",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": f"http://127.0.0.1:{server.server_port}/v1/traces",
        },
    )
    try:
        yield signals, received
    finally:
        signals.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def exported(signals, received):
    signals.traces.force_flush()
    signals.metrics.force_flush()
    result = []
    for path, payload in received:
        message = (
            ExportTraceServiceRequest() if path == "/v1/traces" else ExportMetricsServiceRequest()
        )
        message.ParseFromString(payload)
        result.append(MessageToDict(message))
    return result


async def test_otlp_preserves_parent_and_excludes_user_paths_queries_and_exceptions(collector):
    signals, received = collector
    transport = httpx.ASGITransport(
        app=create_app(config(), catalog=FakeCatalog(), telemetry=signals)
    )
    trace_id = "0123456789abcdef0123456789abcdef"
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            "/api/v1/recommendations/interests?secret=private-query",
            headers={
                "traceparent": f"00-{trace_id}-0123456789abcdef-01",
                "authorization": "Bearer private-token",
                "cookie": "private-cookie",
            },
        )
        assert response.status_code == 200
        await client.get("/private-actor/private-event?email=secret@example.test")
    with pytest.raises(RuntimeError), signals.span("projection"):
        raise RuntimeError("private-exception postgresql://password@db")
    signals.http("private-operation", 503, time.perf_counter())
    signals.result("personal", False)
    data = exported(signals, received)
    serialized = json.dumps(data)
    for sensitive in (
        "private-",
        "secret@example",
        "password",
        "postgresql",
        "authorization",
        "cookie",
    ):
        assert sensitive not in serialized
    traces = [
        span
        for export in data
        for resource in export.get("resourceSpans", [])
        for scope in resource["scopeSpans"]
        for span in scope["spans"]
    ]
    assert any(
        base64.b64decode(span["traceId"]).hex() == trace_id
        and base64.b64decode(span.get("parentSpanId", "")).hex() == "0123456789abcdef"
        for span in traces
    )
    assert any(span.get("status", {}).get("code") == "STATUS_CODE_ERROR" for span in traces)
    metrics = [
        metric
        for export in data
        for resource in export.get("resourceMetrics", [])
        for scope in resource["scopeMetrics"]
        for metric in scope["metrics"]
    ]
    assert {
        "eventflow_recommendations_requests",
        "eventflow_recommendations_request_duration",
        "eventflow_recommendations_results",
    } <= {metric["name"] for metric in metrics}


@pytest.mark.integration
async def test_projection_metrics_reflect_db_checkpoint_and_failure(projection_pool, collector):
    signals, received = collector
    transport = httpx.ASGITransport(
        app=create_app(
            config(), service_pool=projection_pool, catalog=FakeCatalog(), telemetry=signals
        )
    )

    def gauge(name):
        values = [
            metric["gauge"]["dataPoints"][0]["asInt"]
            for export in exported(signals, received)
            for resource in export.get("resourceMetrics", [])
            for scope in resource["scopeMetrics"]
            for metric in scope["metrics"]
            if metric["name"] == "eventflow_recommendations_" + name
        ]
        return int(values[-1])

    async def assert_readiness(http, ready, projected=True):
        response = await http.get("/health/ready")
        assert response.status_code == (200 if ready else 503)
        await signals.projection(projection_pool, projected, time.perf_counter())
        assert gauge("ready") == int(ready)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        await assert_readiness(http, False, projected=False)
        generation = uuid4()
        async with projection_pool.connection() as connection:
            await connection.execute(
                "INSERT INTO recommendation_projection(id,building_generation,building_model,"
                "active_generation,active_model,cursor,through) VALUES (1,%s,'test',%s,'test',2,9)",
                (generation, generation),
            )
        await assert_readiness(http, False)
        async with projection_pool.connection() as connection:
            await connection.execute(
                "UPDATE recommendation_projection SET heartbeat=clock_timestamp() WHERE id=1"
            )
        await assert_readiness(http, True)
        assert gauge("cursor_gap") == 7
        async with projection_pool.connection() as connection:
            await connection.execute(
                "UPDATE recommendation_projection "
                "SET heartbeat=clock_timestamp()-interval '46 seconds' WHERE id=1"
            )
        await assert_readiness(http, False)


@pytest.mark.parametrize(
    "value",
    [
        "ftp://host/path",
        "http://user:password@host",
        "http://host/path?secret=value",
        "http://host/path#secret",
    ],
)
def test_telemetry_endpoint_rejects_credentials_and_unsupported_transport(value):
    with pytest.raises(ValueError):
        endpoint(value)


def test_disabled_telemetry_has_no_export_threads_or_network():
    signals = Telemetry("api", {})
    assert signals.traces is None and signals.metrics is None
    signals.http("private-operation", 200, time.perf_counter())
    signals.close()

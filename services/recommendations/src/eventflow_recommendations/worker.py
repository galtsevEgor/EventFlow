"""Worker-only CPU inference and canonical feed polling; MQ is a wake-up hint."""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import time
from typing import Annotated, Literal
from uuid import UUID

import aio_pika
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from .catalog import CatalogClient
from .config import Config
from .contracts import SourceChange
from .database import pool
from .embeddings import LocalEmbedder, model_manifest
from .policies import (
    WORKER_AMQP_CONNECT_TIMEOUT_SECONDS,
    WORKER_AMQP_PREFETCH_COUNT,
    WORKER_COMPLETE_POLL_DELAY_SECONDS,
    WORKER_FAILURE_BACKOFF_BASE_SECONDS,
    WORKER_FAILURE_BACKOFF_MAX_EXPONENT,
    WORKER_FAILURE_BACKOFF_MAX_SECONDS,
    WORKER_INCOMPLETE_POLL_DELAY_SECONDS,
    WORKER_QUEUE_MAX_LENGTH,
    WORKER_RECONNECT_DELAY_SECONDS,
)
from .projection import Projection
from .runtime import run
from .telemetry import Telemetry

logger = logging.getLogger("recommendations.worker")


class Notification(BaseModel):
    model_config = ConfigDict(extra="forbid")
    eventId: UUID
    eventType: Literal["SearchDocumentChanged.v1"]
    schemaVersion: Annotated[int, Field(strict=True, ge=1, le=1)]
    aggregateId: UUID
    aggregateVersion: Annotated[int, Field(strict=True, ge=1, le=9_007_199_254_740_991)]
    occurredAt: AwareDatetime
    correlationId: UUID
    causationId: UUID | None = None
    traceparent: (
        Annotated[str, Field(pattern=r"^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$")] | None
    ) = None
    producer: Literal["catalog"]
    data: SourceChange

    @field_validator("occurredAt", mode="before")
    @classmethod
    def timestamp(cls, value: object) -> object:
        import re

        if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value
        ):
            raise ValueError("Invalid notification timestamp")
        return value

    @model_validator(mode="after")
    def identity(self) -> Notification:
        if self.data.event_id != self.aggregateId or self.data.position != self.aggregateVersion:
            raise ValueError("Invalid notification identity")
        return self


def validate_notification(body: bytes) -> Notification:
    if len(body) > 65536:
        raise ValueError("Oversized notification")
    return Notification.model_validate_json(body)


async def consume_notifications(config: Config, wake: asyncio.Event, stop: asyncio.Event) -> None:
    while not stop.is_set():
        connection = None
        try:
            connection = await aio_pika.connect_robust(
                config.amqp_url, timeout=WORKER_AMQP_CONNECT_TIMEOUT_SECONDS
            )
            channel = await connection.channel()
            await channel.set_qos(prefetch_count=WORKER_AMQP_PREFETCH_COUNT)
            exchange = await channel.declare_exchange(
                config.namespace + ".events", aio_pika.ExchangeType.TOPIC, durable=True
            )
            queue = await channel.declare_queue(
                config.namespace + ".recommendations",
                durable=True,
                arguments={
                    "x-queue-type": "quorum",
                    "x-max-length": WORKER_QUEUE_MAX_LENGTH,
                    "x-overflow": "reject-publish",
                },
            )
            await queue.bind(exchange, routing_key="SearchDocumentChanged.v1")

            async def receive(message: aio_pika.abc.AbstractIncomingMessage) -> None:
                try:
                    validate_notification(message.body)
                except ValueError:
                    await message.reject(requeue=False)
                    return
                wake.set()
                await message.ack()

            tag = await queue.consume(receive)
            await stop.wait()
            await queue.cancel(tag)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Only stable codes: transport exceptions may contain credential-bearing URLs.
            logger.warning("recommendations_notification_unavailable")
            try:
                await asyncio.wait_for(stop.wait(), timeout=WORKER_RECONNECT_DELAY_SECONDS)
            except TimeoutError:
                pass
        finally:
            if connection is not None:
                await connection.close()


async def poll(
    projection: Projection,
    wake: asyncio.Event,
    stop: asyncio.Event,
    telemetry: Telemetry | None = None,
) -> None:
    failures = 0
    signals = telemetry or Telemetry("worker", {})
    while not stop.is_set():
        wake.clear()
        started = time.perf_counter()
        try:
            with signals.span("projection"):
                complete = await projection.sync_once()
            if telemetry:
                await telemetry.projection(projection.pool, True, started)
            if failures:
                logger.info("recommendations_projection_recovered")
            failures = 0
            delay = (
                WORKER_COMPLETE_POLL_DELAY_SECONDS
                if complete
                else WORKER_INCOMPLETE_POLL_DELAY_SECONDS
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            if telemetry:
                await telemetry.projection(projection.pool, False, started)
            failures += 1
            logger.warning("recommendations_projection_unavailable")
            delay = min(
                WORKER_FAILURE_BACKOFF_MAX_SECONDS,
                WORKER_FAILURE_BACKOFF_BASE_SECONDS
                ** min(failures, WORKER_FAILURE_BACKOFF_MAX_EXPONENT),
            )
        waiting = [asyncio.create_task(wake.wait()), asyncio.create_task(stop.wait())]
        try:
            await asyncio.wait(waiting, timeout=delay, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in waiting:
                task.cancel()
            await asyncio.gather(*waiting, return_exceptions=True)


async def serve(rebuild: bool = False) -> None:
    config = Config.read()
    signals = Telemetry("worker")
    stop, wake = asyncio.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: loop.call_soon_threadsafe(stop.set))
    service_pool = pool(config.database_url)
    feed = CatalogClient(config)
    consumer = None
    try:
        await service_pool.open()
        await service_pool.wait()
        manifest = model_manifest()
        with signals.span("model_load"):
            embedder = (
                None
                if rebuild
                else await asyncio.to_thread(LocalEmbedder, config.model_path, config.threads)
            )
        projection = Projection(
            service_pool, feed, embedder, manifest["modelId"] + "@" + manifest["revision"]
        )
        if rebuild:
            await projection.rebuild()
            return
        consumer = asyncio.create_task(consume_notifications(config, wake, stop))
        await poll(projection, wake, stop, signals)
    finally:
        stop.set()
        if consumer is not None:
            consumer.cancel()
            await asyncio.gather(consumer, return_exceptions=True)
        await feed.close()
        await service_pool.close()
        await asyncio.to_thread(signals.close)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    # Library transports can include private URLs in log messages.
    for name in (
        "aio_pika",
        "aiormq",
        "httpx",
        "httpcore",
        "psycopg.pool",
        "opentelemetry.exporter",
    ):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    run(serve(args.rebuild))


if __name__ == "__main__":
    main()

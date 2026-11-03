import asyncio
import json
import time
from dataclasses import replace
from datetime import UTC, datetime
from uuid import uuid4

import aio_pika
import pytest

from eventflow_recommendations.config import Config
from eventflow_recommendations.worker import consume_notifications


@pytest.mark.integration
async def test_real_quorum_notification_wakes_worker_and_invalid_message_does_not_requeue() -> None:
    config = replace(Config.read(), namespace="eventflow-test-" + uuid4().hex)
    wake, stop = asyncio.Event(), asyncio.Event()
    consumer = asyncio.create_task(consume_notifications(config, wake, stop))
    connection = await aio_pika.connect(config.amqp_url, timeout=5)
    channel = await connection.channel()
    exchange = await channel.declare_exchange(
        config.namespace + ".events", aio_pika.ExchangeType.TOPIC, durable=True
    )
    event_id, envelope_id = str(uuid4()), str(uuid4())
    body = json.dumps(
        {
            "eventId": envelope_id,
            "eventType": "SearchDocumentChanged.v1",
            "schemaVersion": 1,
            "aggregateId": event_id,
            "aggregateVersion": 1,
            "occurredAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "producer": "catalog",
            "correlationId": str(uuid4()),
            "data": {"position": 1, "eventId": event_id, "document": None},
        }
    ).encode()
    try:
        deadline = time.monotonic() + 10
        while not wake.is_set() and time.monotonic() < deadline:
            for payload in (b"not-json", body):
                await exchange.publish(
                    aio_pika.Message(payload), "SearchDocumentChanged.v1", mandatory=False
                )
            await asyncio.sleep(0.05)
        assert wake.is_set()
        stop.set()
        await asyncio.wait_for(consumer, timeout=5)
        queue = await channel.get_queue(config.namespace + ".recommendations")
        assert queue.declaration_result.message_count == 0
    finally:
        stop.set()
        consumer.cancel()
        await asyncio.gather(consumer, return_exceptions=True)
        await channel.queue_delete(config.namespace + ".recommendations")
        await exchange.delete()
        await connection.close()

import { connect } from 'amqplib';
import { retryDelays } from '../../packages/messaging/dist/index.js';

export async function cleanBroker(namespace) {
  if (!/^eventflow-test-[a-f0-9-]{36}$/.test(namespace))
    throw new Error('Only isolated test queues may be removed');
  const connection = await connect(process.env.AMQP_URL);
  try {
    const channel = await connection.createChannel();
    for (const consumer of [
      'catalog',
      'booking',
      'payments',
      'tickets',
      'statistics',
      'realtime',
      'booking-refunds',
      'ticket-refunds',
      'payment-refunds',
      'catalog-refunds',
    ]) {
      const queue = `${namespace}.${consumer}`;
      for (const name of [
        queue,
        `${queue}.dlq`,
        ...retryDelays.map((delay) => `${queue}.retry.${delay}`),
      ])
        await channel.deleteQueue(name);
    }
    await channel.deleteExchange(`${namespace}.events`);
  } finally {
    await connection.close();
  }
}

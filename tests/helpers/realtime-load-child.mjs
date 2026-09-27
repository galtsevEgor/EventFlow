import { realtimeFixture } from './realtime.mjs';
import { realtimeInvalidation } from '../../packages/event-contracts/dist/index.js';
import { eventually } from './eventually.mjs';

const fixture = await realtimeFixture(
  { REALTIME_HEARTBEAT_MS: '5000', REALTIME_IP_CONNECTIONS: '128' },
  { snapshotSeats: 1000 },
);
let baseline,
  peak = 0,
  sampler;
const replica = await fixture.start();
process.send({ type: 'ready', origin: replica.origin, saleId: fixture.saleId });
process.on('message', async (message) => {
  try {
    if (message.type === 'begin') {
      baseline = {
        cpu: process.cpuUsage(),
        time: performance.now(),
        requests: fixture.requests(),
        memory: process.memoryUsage().rss,
      };
      peak = baseline.memory;
      sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 100);
      process.send({ type: 'begun' });
    }
    if (message.type === 'change') {
      const revision = fixture.bump(),
        changedAt = Date.now();
      await replica.bus.worker.broker.publish(
        realtimeInvalidation('booking', { scope: 'sale', id: fixture.saleId }),
      );
      process.send({ type: 'changed', revision, changedAt });
    }
    if (message.type === 'measure') {
      const cpu = process.cpuUsage(baseline.cpu),
        wallMs = performance.now() - baseline.time;
      clearInterval(sampler);
      peak = Math.max(peak, process.memoryUsage().rss);
      const report = {
        cpuMs: (cpu.user + cpu.system) / 1000,
        wallMs,
        cpuPercent: ((cpu.user + cpu.system) / 1000 / wallMs) * 100,
        rssStartMiB: baseline.memory / 1048576,
        rssPeakMiB: peak / 1048576,
        upstreamRequests: fixture.requests() - baseline.requests,
        streams: replica.hub.snapshot(),
      };
      process.send({ type: 'measured', report });
    }
    if (message.type === 'stop') {
      clearInterval(sampler);
      await eventually(
        () => replica.hub.snapshot().active,
        (n) => n === 0,
      );
      await fixture.close();
      process.disconnect();
    }
  } catch {
    process.send({ type: 'error', message: 'Realtime profile child failed' });
  }
});

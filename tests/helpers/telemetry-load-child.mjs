import { realtimeFixture } from './realtime.mjs';
import { currentTelemetry } from '../../packages/telemetry/dist/index.js';
const fixture = await realtimeFixture({}, { snapshotSeats: 1000 });
process.env.BOOKING_URL = fixture.config.BOOKING_URL;
process.env.CATALOG_URL = fixture.config.CATALOG_URL;
const replica = await fixture.start();
const telemetry = currentTelemetry();
let baseline, sampler, peak;
process.send({ type: 'ready', origin: replica.origin, saleId: fixture.saleId });
process.on('message', async (message) => {
  try {
    if (message.type === 'begin') {
      baseline = {
        cpu: process.cpuUsage(),
        time: performance.now(),
        memory: process.memoryUsage().rss,
      };
      peak = baseline.memory;
      sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 100);
      process.send({ type: 'begun' });
    }
    if (message.type === 'measure') {
      clearInterval(sampler);
      const cpu = process.cpuUsage(baseline.cpu);
      process.send({
        type: 'measured',
        cpuMs: (cpu.user + cpu.system) / 1000,
        wallMs: performance.now() - baseline.time,
        rssStartMiB: baseline.memory / 1048576,
        rssPeakMiB: peak / 1048576,
      });
    }
    if (message.type === 'stop') {
      clearInterval(sampler);
      await telemetry?.flush();
      await fixture.close();
      process.disconnect();
    }
  } catch {
    process.send({ type: 'error', message: 'Telemetry load child failed' });
  }
});

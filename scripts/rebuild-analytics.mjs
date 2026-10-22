import { parseArgs } from 'node:util';
import { ClickHouse } from '../services/analytics/dist/clickhouse.js';
import { Journal } from '../services/analytics/dist/journal.js';
import { AnalyticsProjection } from '../services/analytics/dist/projection.js';
import { readAnalyticsConfig } from '../services/analytics/dist/config.js';
parseArgs({ options: {}, strict: true, allowPositionals: false });
const config = readAnalyticsConfig(process.env),
  journal = new Journal(config.ANALYTICS_DATABASE_URL);
try {
  const result = await new AnalyticsProjection(journal, new ClickHouse(config)).rebuild();
  if (!result) throw new Error('Analytics writer busy; retry after the active export completes');
  console.log(JSON.stringify(result));
} finally {
  await journal.onModuleDestroy();
}

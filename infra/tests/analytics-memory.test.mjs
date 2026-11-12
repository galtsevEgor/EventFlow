import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';

const options = { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 };
const docker = (...args) => execFileSync('docker', args, options).trim();

test(
  'wide metric log merges fit the unchanged local memory budget on fresh and existing volumes',
  { timeout: 180000 },
  async (t) => {
    const config = JSON.parse(
      docker(
        'compose',
        '--project-directory',
        '.',
        '--env-file',
        '.env',
        '-f',
        'infra/compose/compose.yaml',
        'config',
        '--format',
        'json',
      ),
    );
    const service = config.services.clickhouse;
    const name = 'eventflow-clickhouse-memory-' + randomUUID();
    const credentials = ['--user', 'memory_probe', '--password', 'local-regression-only'];
    const query = (sql) =>
      execFileSync(
        'docker',
        [
          'exec',
          '-i',
          name,
          'clickhouse-client',
          ...credentials,
          '--multiquery',
          '--max_threads=2',
          '--max_query_size=1048576',
        ],
        { ...options, input: sql },
      ).trim();
    const rows = (sql) => JSON.parse(query(sql + ' FORMAT JSON')).data;
    const ready = async () => {
      for (let i = 0; i < 90; i++) {
        const status = docker('inspect', '--format', '{{.State.Health.Status}}', name);
        if (status === 'healthy') return;
        assert.notEqual(status, 'unhealthy', 'ClickHouse failed its final-server healthcheck');
        await setTimeout(500);
      }
      assert.fail('ClickHouse did not finish authenticated initialization');
    };
    const settings = () => {
      const [table] = rows(
        "SELECT engine_full FROM system.tables WHERE database='system' AND name='metric_log'",
      );
      assert.match(table.engine_full, /vertical_merge_algorithm_min_rows_to_activate = 1(?:,|$)/);
      assert.match(table.engine_full, /vertical_merge_algorithm_min_bytes_to_activate = 0(?:,|$)/);
    };

    assert.equal(service.environment.CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS, '1');
    assert.equal(Number(service.mem_limit), 1280 * 1024 * 1024);
    assert.equal(Number(service.cpus), 1);
    try {
      docker(
        'run',
        '--detach',
        '--name',
        name,
        '--network',
        'none',
        '--memory',
        String(service.mem_limit),
        '--cpus',
        String(service.cpus),
        '--ulimit',
        'nofile=65536:65536',
        '--env',
        'CLICKHOUSE_USER=memory_probe',
        '--env',
        'CLICKHOUSE_PASSWORD=local-regression-only',
        '--env',
        'CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1',
        '--health-cmd',
        service.healthcheck.test[1].replaceAll('$$', '$'),
        '--health-interval',
        '1s',
        '--health-timeout',
        '3s',
        '--health-retries',
        '60',
        ...service.volumes
          .filter((volume) => volume.type === 'bind')
          .flatMap((volume) => [
            '--mount',
            `type=bind,source=${volume.source},target=${volume.target},readonly`,
          ]),
        service.image,
      );
      await ready();
      settings();
      assert.equal(
        query("SELECT value FROM system.server_settings WHERE name='max_server_memory_usage'"),
        String(900 * 1024 * 1024),
      );

      // Copy the actual log schema and its configured engine, including >2,000 columns.
      query('CREATE TABLE default.merge_probe AS system.metric_log');
      query('SYSTEM STOP MERGES default.merge_probe');
      const columns = rows(
        "SELECT name FROM system.columns WHERE database='system' AND table='metric_log' AND type IN ('UInt64','Int64','Float64') ORDER BY position",
      ).map(({ name }) => name);
      assert.ok(columns.length > 2000);
      assert.ok(columns.every((column) => /^[A-Za-z_][A-Za-z_0-9]*$/.test(column)));
      // Each column varies by row, while the projection can reuse one series in memory.
      const projection = columns.map((column) => `number AS ${column}`).join(',');
      for (let i = 0; i < 2; i++) {
        query(
          `INSERT INTO default.merge_probe (${columns.join(',')}) SELECT ${projection}` +
            ` FROM numbers(${i * 10000},10000) SETTINGS max_block_size=10000,min_insert_block_size_rows=10000`,
        );
      }
      const parts = rows(
        "SELECT rows,part_type FROM system.parts WHERE database='default' AND table='merge_probe' AND active",
      );
      assert.equal(parts.length, 2);
      assert.ok(parts.every((part) => Number(part.rows) === 10000 && part.part_type === 'Wide'));
      query('SYSTEM START MERGES default.merge_probe; OPTIMIZE TABLE default.merge_probe FINAL');
      query('SYSTEM FLUSH LOGS part_log');
      const merges = rows(
        "SELECT rows,merge_algorithm,peak_memory_usage,error FROM system.part_log WHERE database='default' AND table='merge_probe' AND event_type='MergeParts'",
      );
      assert.ok(merges.length > 0);
      for (const merge of merges) {
        assert.equal(merge.error, 0);
        assert.equal(merge.merge_algorithm, 'Vertical');
        assert.equal(Number(merge.rows), 20000);
        assert.ok(Number(merge.peak_memory_usage) < 128 * 1024 * 1024);
      }
      t.diagnostic('Wide log merge peak memory: ' + merges[0].peak_memory_usage + ' bytes');

      query('SYSTEM FLUSH LOGS metric_log');
      const metricRows = Number(
        query("SELECT count() FROM merge('system', '^metric_log(_[0-9]+)?$')"),
      );
      assert.ok(metricRows > 0);
      // Simulate a persisted volume created with the old horizontal merge threshold.
      query(
        'ALTER TABLE system.metric_log MODIFY SETTING vertical_merge_algorithm_min_rows_to_activate=131072',
      );
      docker('restart', name);
      await ready();
      settings();
      assert.equal(Number(query('SELECT count() FROM default.merge_probe')), 20000);
      assert.ok(
        Number(query("SELECT count() FROM merge('system', '^metric_log(_[0-9]+)?$')")) >=
          metricRows,
      );
      const archives = rows(
        "SELECT engine_full FROM system.tables WHERE database='system' AND match(name, '^metric_log_[0-9]+$')",
      );
      assert.equal(archives.length, 1);
      assert.match(
        archives[0].engine_full,
        /vertical_merge_algorithm_min_rows_to_activate = 1(?:,|$)/,
      );
      assert.match(
        archives[0].engine_full,
        /vertical_merge_algorithm_min_bytes_to_activate = 0(?:,|$)/,
      );
      const generation = query(
        "SELECT toString(uuid) FROM system.tables WHERE database='system' AND name='metric_log'",
      );
      docker('restart', name);
      await ready();
      settings();
      assert.equal(
        query(
          "SELECT toString(uuid) FROM system.tables WHERE database='system' AND name='metric_log'",
        ),
        generation,
      );
    } catch (error) {
      const logs = spawnSync('docker', ['logs', '--tail', '35', name], options);
      t.diagnostic((logs.stdout + logs.stderr).slice(-6000));
      throw error;
    } finally {
      spawnSync('docker', ['rm', '--force', '--volumes', name], options);
    }
  },
);

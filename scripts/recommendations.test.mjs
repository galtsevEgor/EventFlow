import assert from 'node:assert/strict';
import test from 'node:test';
import { pythonPaths, pythonTask, runGroup } from './recommendations.mjs';
test('Python runtime and model assets stay outside tracked service sources', () => {
  const paths = pythonPaths(process.cwd(), {}, 'win32');
  assert.match(paths.environment, /work[\\/]e21[\\/]python$/);
  assert.match(paths.python, /Scripts[\\/]python.exe$/);
  assert.equal(paths.variables.PYTHONUTF8, '1');
  assert.ok(
    paths.variables.PYTHONPATH.endsWith('recommendations\\src') ||
      paths.variables.PYTHONPATH.endsWith('recommendations/src'),
  );
  assert.deepEqual(
    pythonTask('model:verify', [], { RECOMMENDATIONS_MODEL_PATH: 'C:/private model' }),
    [
      [
        '-m',
        'eventflow_recommendations.embeddings',
        'verify-model',
        '--model-path',
        'C:/private model',
      ],
    ],
  );
  assert.throws(() => pythonTask('arbitrary-executable'), /Unknown/);
});

test(
  'local API and worker group stops its sibling when one process fails',
  { timeout: 5000 },
  async () => {
    const started = Date.now();
    const code = await runGroup(
      [
        [process.execPath, ['-e', 'setTimeout(() => process.exit(17), 250)']],
        [process.execPath, ['-e', 'setInterval(() => {}, 1000)']],
      ],
      { stdio: 'ignore' },
    );
    assert.equal(code, 17);
    assert.ok(Date.now() - started < 4000);
  },
);

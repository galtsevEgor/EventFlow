import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { pythonPaths, pythonTask, recommendationsModelPath, runGroup } from './recommendations.mjs';
test('Python runtime and model assets stay outside tracked service sources', () => {
  const paths = pythonPaths(process.cwd(), {}, 'win32');
  assert.match(paths.environment, /work[\\/]e21[\\/]python$/);
  assert.match(paths.python, /Scripts[\\/]python.exe$/);
  assert.equal(paths.variables.PYTHONUTF8, '1');
  assert.ok(
    paths.variables.PYTHONPATH.endsWith('recommendations\\src') ||
      paths.variables.PYTHONPATH.endsWith('recommendations/src'),
  );
  const override = resolve(tmpdir(), 'private model');
  assert.deepEqual(pythonTask('model:verify', [], { RECOMMENDATIONS_MODEL_PATH: override }), [
    ['-m', 'eventflow_recommendations.embeddings', 'verify-model', '--model-path', override],
  ]);
  assert.throws(() => pythonTask('arbitrary-executable'), /Unknown/);
});

test('model commands and runtime resolve the same path from any working directory', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const expected = recommendationsModelPath(root);
  const original = process.cwd();
  try {
    process.chdir(tmpdir());
    const { variables } = pythonPaths(root, {});
    assert.equal(variables.RECOMMENDATIONS_MODEL_PATH, expected);
    assert.equal(
      pythonPaths(root, { RECOMMENDATIONS_MODEL_PATH: '' }).variables.RECOMMENDATIONS_MODEL_PATH,
      expected,
    );
    assert.equal(pythonTask('model:setup', [], {})[0].at(-1), expected);
    assert.equal(pythonTask('evaluate', [], variables)[0].at(-1), expected);
    assert.equal(
      pythonPaths(root, { RECOMMENDATIONS_MODEL_PATH: 'work/custom model' }).variables
        .RECOMMENDATIONS_MODEL_PATH,
      resolve(root, 'work/custom model'),
    );
  } finally {
    process.chdir(original);
  }
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

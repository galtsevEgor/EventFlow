import assert from 'node:assert/strict';
import test from 'node:test';
import { pythonPaths, pythonTask } from './recommendations.mjs';
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

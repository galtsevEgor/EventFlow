import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

export function pythonPaths(root, env = process.env, platform = process.platform) {
  const environment = resolve(root, 'work/e21/python');
  return {
    root,
    service: resolve(root, 'services/recommendations'),
    environment,
    python: resolve(environment, platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    variables: {
      ...env,
      UV_PROJECT_ENVIRONMENT: environment,
      PYTHONPATH: [resolve(root, 'services/recommendations/src'), env.PYTHONPATH]
        .filter(Boolean)
        .join(delimiter),
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      TOKENIZERS_PARALLELISM: 'false',
    },
  };
}

export function pythonTask(task, extra = [], env = process.env) {
  const model =
    env.RECOMMENDATIONS_MODEL_PATH ??
    resolve('work/e21/models/paraphrase-multilingual-MiniLM-L12-v2');
  const commands = {
    check: [
      ['-m', 'ruff', 'check', 'src', 'tests'],
      ['-m', 'ruff', 'format', '--check', 'src', 'tests'],
      ['-m', 'mypy', 'src'],
    ],
    format: [
      ['-m', 'ruff', 'check', '--fix', 'src', 'tests'],
      ['-m', 'ruff', 'format', 'src', 'tests'],
    ],
    test: [['-m', 'pytest', 'tests', '-q', ...extra]],
    'model:setup': [
      ['-m', 'eventflow_recommendations.embeddings', 'setup-model', '--model-path', model],
    ],
    'model:verify': [
      ['-m', 'eventflow_recommendations.embeddings', 'verify-model', '--model-path', model],
    ],
  };
  if (!Object.hasOwn(commands, task)) throw new Error('Unknown recommendations command');
  return commands[task];
}

export async function execute(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const cleanup = () => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code) => {
      cleanup();
      done(code ?? 1);
    });
  });
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url)),
    paths = pythonPaths(root);
  const [task, ...extra] = process.argv.slice(2);
  if (task === 'setup') {
    mkdirSync(resolve(root, 'work/e21'), { recursive: true });
    const code = await execute(
      process.env.PYTHON ?? 'python',
      ['-m', 'uv', 'sync', '--locked', '--project', paths.service],
      { cwd: root, env: paths.variables },
    );
    if (code !== 0)
      throw new Error('Isolated Python setup failed. Python3.12 and uv0.11.7 are required.');
    return;
  }
  const commands = pythonTask(task, extra, paths.variables);
  if (!existsSync(paths.python)) throw new Error('Run pnpm recommendations setup first.');
  for (const args of commands) {
    const code = await execute(paths.python, args, { cwd: paths.service, env: paths.variables });
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

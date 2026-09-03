import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const privateDirectories = new Set([
  'docs',
  'work',
  '.agents',
  '.claude',
  '.codex',
  '.gemini',
  '.antigravity',
  '.cursor',
  '.claude-flow',
  '.ruflo',
  'prompts',
  'handoffs',
]);
const privateFiles = new Set(['.cursorrules', '.mcp.json', '.claude.json']);

export function findPrivatePaths(paths) {
  return [...new Set(paths)]
    .filter((path) => {
      const segments = path.replaceAll('\\', '/').toLowerCase().split('/');
      const name = segments.at(-1);
      return (
        segments.some((segment) => privateDirectories.has(segment)) ||
        privateFiles.has(name) ||
        /\.(md|mdx|pem|key|log)$/.test(name) ||
        /^(agents|claude|gemini)\./.test(name) ||
        (name !== '.env.example' && /^\.env(?:\.|$)/.test(name))
      );
    })
    .sort();
}

export function checkRepository(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--staged')) {
    throw new Error('Usage: repository-policy.mjs [--staged]');
  }
  const gitArgs =
    args[0] === '--staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
      : ['ls-files', '-z'];
  const paths = execFileSync('git', gitArgs, { encoding: 'utf8' }).split('\0').filter(Boolean);
  const denied = findPrivatePaths(paths);
  if (denied.length) {
    console.error(`Private files must stay outside Git:\n${denied.join('\n')}`);
    return 1;
  }
  console.log(`Repository policy passed (${paths.length} paths).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = checkRepository();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

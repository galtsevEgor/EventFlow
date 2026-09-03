import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runTool } from './quality-tools.mjs';

runTool('gitleaks', ['git', '.', '--log-opts=--all', '--redact', '--no-banner']);
mkdirSync('work/scans', { recursive: true });
const directory = mkdtempSync(resolve('work/scans/tracked-'));
try {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`Cannot scan a tracked symlink: ${file}`);
    const target = resolve(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  runTool('gitleaks', ['dir', directory, '--redact', '--no-banner']);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

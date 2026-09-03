import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findPrivatePaths } from './repository-policy.mjs';

test('rejects private files at any depth and with either separator', () => {
  const paths = [
    'README.md',
    'a/DOCS/spec.json',
    'x\\.codex\\settings.json',
    'AGENTS.md',
    'a/CLAUDE.txt',
    '.env',
    'a/.env.production',
    'a/private.key',
    'run.log',
    'a/prompts/input.txt',
  ];
  assert.deepEqual(findPrivatePaths(paths), [...paths].sort());
});

test('permits source, tests, runtime contracts and safe configuration', () => {
  assert.deepEqual(
    findPrivatePaths([
      'src/docs-utils.ts',
      'src/work-item.ts',
      'tests/booking.test.ts',
      'schemas/order.json',
      '.github/workflows/ci.yml',
      '.env.example',
      'infra/.env.example',
      'package.json',
      'pnpm-lock.yaml',
    ]),
    [],
  );
});

test('returns a sorted deduplicated list while preserving path spelling', () => {
  assert.deepEqual(findPrivatePaths(['b.md', 'A.MD', 'b.md']), ['A.MD', 'b.md']);
});

test('CLI checks the actual Git index and never checks untracked local notes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eventflow-policy-'));
  const script = fileURLToPath(new URL('./repository-policy.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory });
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: directory });
    writeFileSync(join(directory, 'notes.md'), 'local');
    writeFileSync(join(directory, 'app.ts'), 'export {};');
    execFileSync('git', ['add', 'app.ts'], { cwd: directory });
    assert.equal(run().status, 0);
    execFileSync('git', ['add', 'notes.md'], { cwd: directory });
    assert.equal(run().status, 1);
    assert.equal(run('--staged').status, 1);
    assert.equal(run('--unknown').status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

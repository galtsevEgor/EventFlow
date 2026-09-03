import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(
  readFileSync(new URL('../config/quality-tools.json', import.meta.url), 'utf8'),
);
const root = fileURLToPath(new URL('../', import.meta.url));

export function toolPath(name) {
  const tool = manifest.find((tool) => tool.tool === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return resolve(
    root,
    'work/tools',
    tool.tool,
    tool.version,
    `${name}${process.platform === 'win32' ? '.exe' : ''}`,
  );
}

export function runTool(name, args, options = {}) {
  const result = spawnSync(toolPath(name), args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw new Error(`Run pnpm tools:setup first: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${name} failed with status ${result.status}`);
}

async function install() {
  if (process.arch !== 'x64' || !['win32', 'linux'].includes(process.platform)) {
    throw new Error('Pinned development tools currently support Windows/Linux x64.');
  }
  for (const tool of manifest) {
    const artifact = tool[process.platform === 'win32' ? 'windows' : 'linux'];
    const directory = resolve(root, 'work/tools', tool.tool, tool.version);
    mkdirSync(directory, { recursive: true });
    const archive = resolve(directory, basename(artifact.url));
    const response = existsSync(archive)
      ? null
      : await fetch(artifact.url, { signal: AbortSignal.timeout(60000) });
    if (response && !response.ok)
      throw new Error(`Download failed: ${tool.tool} HTTP ${response.status}`);
    const data = response ? Buffer.from(await response.arrayBuffer()) : readFileSync(archive);
    if (createHash('sha256').update(data).digest('hex') !== artifact.sha256) {
      throw new Error(`Checksum mismatch: ${tool.tool}`);
    }
    writeFileSync(archive, data);
    const result = spawnSync(
      'tar',
      ['-xf', archive, '-C', directory, basename(toolPath(tool.tool))],
      { stdio: 'inherit', windowsHide: true },
    );
    if (result.error || result.status !== 0) throw new Error(`Extraction failed: ${tool.tool}`);
    console.log(`${tool.tool} ${tool.version}: checksum verified and installed locally.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await install();

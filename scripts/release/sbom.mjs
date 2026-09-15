import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const components = new Map();
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) inspect(path);
    else {
      const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
      const { name, version } = manifest;
      const ref = `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
      components.set(ref, { type: 'library', name, version, 'bom-ref': ref, purl: ref });
    }
  }
}
const store = 'node_modules/.pnpm';
for (const entry of readdirSync(store, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== 'node_modules')
    inspect(join(store, entry.name, 'node_modules'));
}
console.log(
  JSON.stringify(
    {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
      components: [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl)),
    },
    null,
    2,
  ),
);

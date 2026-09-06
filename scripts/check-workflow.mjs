import { runTool } from './quality-tools.mjs';
import { readdirSync } from 'node:fs';

const workflows = readdirSync('.github/workflows')
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => `.github/workflows/${name}`);
runTool('actionlint', ['-color', '-shellcheck=', '-pyflakes=', ...workflows]);

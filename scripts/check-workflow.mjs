import { runTool } from './quality-tools.mjs';

runTool('actionlint', ['-color', '-shellcheck=', '-pyflakes=', '.github/workflows/ci.yml']);

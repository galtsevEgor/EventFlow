import { bundleWorkflowCode } from '@temporalio/worker';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const bundle = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('dist/workflow.js', import.meta.url)),
});
writeFileSync(new URL('dist/workflow-bundle.js', import.meta.url), bundle.code);

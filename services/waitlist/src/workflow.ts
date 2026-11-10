import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

export type WaitlistStep = { stopped: boolean; wakeAfterMs: number };
export type WaitlistActivities = { advance(saleId: string): Promise<WaitlistStep> };
export const wake = defineSignal('wake');

const MAX_ADVANCES_PER_RUN = 500;
const MIN_WORKFLOW_WAIT_MS = 100;
const MAX_WORKFLOW_WAIT_MS = 30_000;
const ADVANCE_ACTIVITY_TIMEOUT = '30 seconds';
const ADVANCE_RETRY_INITIAL_INTERVAL = '1 second';
const ADVANCE_RETRY_MAX_INTERVAL = '30 seconds';

const { advance } = proxyActivities<WaitlistActivities>({
  startToCloseTimeout: ADVANCE_ACTIVITY_TIMEOUT,
  retry: {
    initialInterval: ADVANCE_RETRY_INITIAL_INTERVAL,
    maximumInterval: ADVANCE_RETRY_MAX_INTERVAL,
  },
});
export async function waitlistWorkflow(saleId: string) {
  let revision = 0;
  setHandler(wake, () => {
    revision++;
  });
  let iterations = 0;
  while (true) {
    if (++iterations > MAX_ADVANCES_PER_RUN) return continueAsNew<typeof waitlistWorkflow>(saleId);
    const before = revision;
    const step = await advance(saleId);
    if (step.stopped) return;
    await condition(
      () => revision !== before,
      Math.max(MIN_WORKFLOW_WAIT_MS, Math.min(MAX_WORKFLOW_WAIT_MS, step.wakeAfterMs)),
    );
  }
}

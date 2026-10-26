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
const { advance } = proxyActivities<WaitlistActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds' },
});
export async function waitlistWorkflow(saleId: string) {
  let revision = 0;
  setHandler(wake, () => {
    revision++;
  });
  let iterations = 0;
  while (true) {
    if (++iterations > 500) return continueAsNew<typeof waitlistWorkflow>(saleId);
    const before = revision;
    const step = await advance(saleId);
    if (step.stopped) return;
    await condition(() => revision !== before, Math.max(100, Math.min(30000, step.wakeAfterMs)));
  }
}

import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

export type WaitlistStep = { stopped: boolean; wakeAfterMs: number };
export type WaitlistActivities = { advance(saleId: string): Promise<WaitlistStep> };
export const wake = defineSignal('wake');
export const stop = defineSignal('stop');
const { advance } = proxyActivities<WaitlistActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '30 seconds' },
});
export async function waitlistWorkflow(saleId: string) {
  let revision = 0,
    stopped = false;
  setHandler(wake, () => {
    revision++;
  });
  setHandler(stop, () => {
    stopped = true;
  });
  while (!stopped) {
    const before = revision;
    const step = await advance(saleId);
    if (step.stopped) return;
    await condition(
      () => stopped || revision !== before,
      Math.max(100, Math.min(30000, step.wakeAfterMs)),
    );
  }
}

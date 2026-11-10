export const PAYMENT_PROCESSING_LEASE_SECONDS = 60;

// Workers read the recorded failure count before incrementing it for the current failure.
export const PAYMENT_REVIEW_FAILURE_THRESHOLD = 7;
const PAYMENT_RETRY_INITIAL_DELAY_MS = 1_000;
const PAYMENT_RETRY_MAX_DELAY_MS = 60_000;

const PROVIDER_RESEND_MAX_AGE_MS = 23 * 60 * 60 * 1_000;

export function paymentRetryAt(previousFailures: number, now = Date.now()) {
  const delay = Math.min(
    PAYMENT_RETRY_MAX_DELAY_MS,
    PAYMENT_RETRY_INITIAL_DELAY_MS * 2 ** previousFailures,
  );
  return new Date(now + delay);
}

export function providerResendWindowExpired(createdAt: Date, now = Date.now()) {
  return now - createdAt.getTime() >= PROVIDER_RESEND_MAX_AGE_MS;
}

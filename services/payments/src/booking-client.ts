import { z } from 'zod';
import { ApiError } from '@eventflow/service-runtime';
import { paymentOrderSchema } from '@eventflow/event-contracts';
import type { PaymentsConfig } from './config';

export class BookingClient {
  private token: { value: string; expires: number } | undefined;
  constructor(private readonly config: PaymentsConfig) {}
  private async serviceToken() {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    try {
      const response = await fetch(`${this.config.OIDC_ISSUER}/protocol/openid-connect/token`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        body: new URLSearchParams({
          client_id: 'eventflow-payments',
          grant_type: 'client_credentials',
          client_secret: this.config.PAYMENTS_CLIENT_SECRET,
        }),
      });
      if (!response.ok) throw new Error('Machine identity unavailable');
      const result = z
        .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
        .parse(await response.json());
      this.token = {
        value: result.access_token,
        expires: Date.now() + Math.max(0, result.expires_in - 30) * 1000,
      };
      return result.access_token;
    } catch {
      throw new ApiError(503, 'IDENTITY_UNAVAILABLE', 'Проверка платежа временно недоступна.');
    }
  }
  private async request(path: string, token: string, body?: object) {
    try {
      const response = await fetch(new URL(path, this.config.BOOKING_URL), {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 404) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
      if (response.status === 409)
        throw new ApiError(409, 'PAYMENT_ATTEMPT_EXISTS', 'Платёжная попытка уже существует.');
      if (!response.ok) throw new Error('Booking unavailable');
      return paymentOrderSchema.parse(await response.json());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'BOOKING_UNAVAILABLE', 'Не удалось проверить состояние заказа.');
    }
  }
  buyerOrder(id: string, authorization: string) {
    return this.request(
      `/internal/buyer/orders/${id}/payment-state`,
      authorization.replace(/^Bearer /, ''),
    );
  }
  async state(id: string) {
    return this.request(`/internal/orders/${id}/payment-state`, await this.serviceToken());
  }
  async authorize(
    orderId: string,
    attemptId: string,
    buyerSubject: string,
    provider: 'fake' | 'stripe',
  ) {
    return this.request(
      `/internal/orders/${orderId}/payment-authorization`,
      await this.serviceToken(),
      { attemptId, buyerSubject, provider },
    );
  }
}

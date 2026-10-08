import { z } from 'zod';
import type { Schemas } from '../api';
export type Source = 'payments' | 'catalog' | 'tickets';
export type Kind = Schemas['OpsIssue']['kind'];
export type Target = { service: Source; kind: Kind; id: string };
export const targetSchema = z.object({
  service: z.enum(['payments', 'catalog', 'tickets']),
  kind: z.enum(['payment', 'refund', 'webhook', 'mail']),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
});
export const sourceNames: Record<Source, string> = {
  payments: 'Платежи и возвраты',
  catalog: 'Приглашения',
  tickets: 'Доставка билетов',
};
export const kindNames: Record<Kind, string> = {
  payment: 'Платёж',
  refund: 'Возврат',
  webhook: 'Уведомление провайдера',
  mail: 'Письмо',
};
const states: Record<string, string> = {
  REQUIRES_REVIEW: 'Нужна проверка',
  NEEDS_RECONCILIATION: 'Ожидает сверки',
  UNKNOWN: 'Результат уточняется',
  PENDING: 'В обработке',
  PROCESSING: 'В обработке',
  CREATED: 'Создано',
  SUCCEEDED: 'Выполнено',
  SENT: 'Письмо отправлено',
  SKIPPED: 'Отправка не требуется',
  DEAD: 'Попытки доставки исчерпаны',
  CANCELLED: 'Отменено',
  PROCESSED: 'Обработано',
  CONFIRMED: 'Подтверждён',
  REFUNDED: 'Оплата возвращена',
  EXPIRED: 'Срок брони истёк',
  HELD: 'Места забронированы',
  REFUND_PENDING: 'Возврат в обработке',
};
export const stateName = (state: string) => states[state] ?? state;
export const isWorking = (state: string) =>
  ['NEEDS_RECONCILIATION', 'UNKNOWN', 'PENDING', 'PROCESSING', 'CREATED'].includes(state);
export const formatDate = (value: string) => new Date(value).toLocaleString('ru');
export const formatMoney = (value: number, currency = 'EUR') =>
  new Intl.NumberFormat('ru', { style: 'currency', currency }).format(value / 100);
export function caseUrl(target: Target) {
  return (
    '/organizer/ops?' +
    new URLSearchParams({ source: target.service, kind: target.kind, id: target.id })
  );
}

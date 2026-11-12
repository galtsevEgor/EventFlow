'use client';
import type { Schemas } from '@eventflow/api-client';
import { Button } from '@eventflow/ui';
import { formatPrice } from '../format';

const labels = {
  FENCING: 'Проверяем билеты перед возвратом',
  PENDING: 'Возвращаем полную стоимость заказа',
  REQUIRES_REVIEW: 'Уточняем результат возврата',
  REJECTED: 'Возврат отклонён',
  SUCCEEDED: 'Возврат выполнен',
} satisfies Record<Schemas['OrderRefund']['state'], string>;

export function RefundPanel({
  refund,
  totalMinor,
  refresh,
  busy,
}: {
  refund: Schemas['OrderRefund'];
  totalMinor: number;
  refresh: () => void;
  busy: boolean;
}) {
  const active = ['FENCING', 'PENDING', 'REQUIRES_REVIEW'].includes(refund.state);
  return (
    <section className="payment-panel" aria-label="Возврат оплаты">
      <h2>Возврат оплаты</h2>
      <p role="status">{labels[refund.state]}</p>
      <p>Сумма {formatPrice(totalMinor)} · полный возврат</p>
      <p>Причина {refund.reason}</p>
      {active && (
        <p>Билеты недоступны на время проверки возврата. Повторно оплачивать заказ не нужно.</p>
      )}
      {refund.state === 'REQUIRES_REVIEW' && (
        <p>
          Обратитесь в поддержку с номером операции. Билеты останутся заблокированными до завершения
          проверки.
        </p>
      )}
      {refund.state === 'SUCCEEDED' && (
        <p>Билеты аннулированы. Срок зачисления денег зависит от банка.</p>
      )}
      {refund.state === 'REJECTED' && (
        <p>
          {refund.code === 'TICKETS_USED'
            ? 'Один из билетов уже использован.'
            : refund.code === 'REFUND_WINDOW_CLOSED'
              ? 'Срок возврата закончился.'
              : 'Состав билетов требует проверки поддержки.'}{' '}
          Заказ остаётся подтверждённым.
        </p>
      )}
      {active && (
        <Button variant="secondary" disabled={busy} onClick={refresh}>
          Обновить статус возврата
        </Button>
      )}
      <p>
        <small className="muted">Номер операции {refund.id}</small>
      </p>
    </section>
  );
}

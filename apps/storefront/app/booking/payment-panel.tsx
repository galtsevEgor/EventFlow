'use client';
import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, unwrap, type createApiClient, type Schemas } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';
import { FakePayment } from './fake-payment';

const StripePayment = dynamic(() => import('./stripe-payment'), {
  ssr: false,
  loading: () => <p role="status">Загружаем защищённую форму…</p>,
});

type Payment = Schemas['PaymentStatus'];
export type BuyerApi = ReturnType<typeof createApiClient>;

function message(payment: Payment) {
  if (payment.refundState === 'SUCCEEDED') return 'Возврат выполнен. Заказ не подтверждён.';
  if (
    payment.refundState === 'REQUIRES_REVIEW' ||
    payment.bookingState === 'REQUIRES_REVIEW' ||
    payment.state === 'REQUIRES_REVIEW'
  )
    return 'Платёж требует проверки. Сохраните номер заказа и обратитесь в поддержку. Повторно не оплачивайте.';
  if (payment.refundState === 'UNKNOWN')
    return 'Уточняем результат возврата. Подтверждения пока нет; повторно оплачивать не нужно.';
  if (payment.bookingState === 'REFUND_PENDING')
    return 'Оплата поступила после закрытия брони. Возвращаем полную сумму; места больше не удерживаются.';
  if (payment.bookingState === 'CONFIRMED') return 'Оплата принята, заказ подтверждён.';
  if (payment.state === 'SUCCEEDED')
    return 'Оплата получена. Проверяем бронь; подтверждение заказа ещё не получено.';
  if (payment.state === 'CANCELLED') return 'Платёж отменён.';
  if (payment.state === 'NEEDS_RECONCILIATION')
    return 'Уточняем результат платежа. Повторно не оплачивайте.';
  if (payment.state === 'PROCESSING')
    return 'Платёж обрабатывается. Можно закрыть страницу — результат появится в этом заказе.';
  return payment.canPay
    ? 'Проверьте данные и подтвердите оплату.'
    : 'Подготавливаем оплату и проверяем бронь…';
}

function polling(payment: Payment | null | undefined) {
  if (!payment) return 3000;
  if (
    ['CONFIRMED', 'REFUNDED', 'REQUIRES_REVIEW'].includes(payment.bookingState) ||
    ['CANCELLED', 'REQUIRES_REVIEW'].includes(payment.state) ||
    payment.refundState === 'REQUIRES_REVIEW'
  )
    return false;
  return 3000;
}

export function PaymentPanel({
  id,
  buyer,
  orderState,
  api,
}: {
  id: string;
  buyer: string;
  orderState: Schemas['Order']['state'];
  api: BuyerApi;
}) {
  const cache = useQueryClient();
  const payment = useQuery({
    queryKey: ['payment', id, buyer],
    queryFn: async ({ signal }) => {
      const response = await api.client.GET('/api/v1/orders/{id}/payment-status', {
        params: { path: { id } },
        signal,
      });
      if (response.response.status === 404) return null;
      return unwrap(response);
    },
    refetchInterval: (query) =>
      query.state.error
        ? 3000
        : query.state.data === null && orderState !== 'HELD'
          ? false
          : polling(query.state.data),
  });
  const start = useMutation({
    mutationFn: async () => {
      const storageKey = `eventflow:payment:${buyer}:${id}`;
      let key = sessionStorage.getItem(storageKey);
      if (!key || !/^[a-f0-9-]{36}$/.test(key)) key = crypto.randomUUID();
      // Persist before sending so a lost response or reload reuses the same request.
      sessionStorage.setItem(storageKey, key);
      return unwrap(
        await api.client.POST('/api/v1/orders/{id}/payment-attempt', {
          params: { path: { id }, header: { 'Idempotency-Key': key } },
          body: {},
        }),
      );
    },
    onSettled: () => void payment.refetch(),
  });
  const data = payment.data;
  useEffect(() => {
    if (data?.bookingState) void cache.invalidateQueries({ queryKey: ['order', id, buyer] });
  }, [data?.bookingState, cache, id, buyer]);
  const refresh = () => {
    void payment.refetch();
    void cache.invalidateQueries({ queryKey: ['order', id, buyer] });
  };
  if (payment.isPending) return <p role="status">Проверяем оплату…</p>;
  if (!data && orderState !== 'HELD' && !payment.isError) return null;
  return (
    <section className="payment-panel" aria-label="Оплата заказа">
      <h2>Оплата</h2>
      {payment.isError ? (
        <Alert>Не удалось проверить платёж. Не оплачивайте повторно; обновите статус.</Alert>
      ) : data ? (
        <p role="status">{message(data)}</p>
      ) : (
        <p>Сумма и места зафиксированы в заказе. Откройте форму, чтобы завершить покупку.</p>
      )}
      {!data && !payment.isError && orderState === 'HELD' && (
        <>
          <Button disabled={start.isPending || payment.isFetching} onClick={() => start.mutate()}>
            {start.isPending
              ? 'Подготавливаем…'
              : start.isError
                ? 'Повторить запрос оплаты'
                : 'Перейти к оплате'}
          </Button>
          {start.error && (
            <Alert>
              {start.error instanceof ApiRequestError
                ? start.error.message
                : 'Ответ не получен. Обновите статус или повторите тот же запрос оплаты.'}
            </Alert>
          )}
        </>
      )}
      {data?.canPay &&
        orderState === 'HELD' &&
        !payment.isError &&
        (data.provider === 'fake' ? (
          <FakePayment id={id} api={api} amountMinor={data.amountMinor} refresh={refresh} />
        ) : (
          data.clientSecret &&
          data.publishableKey && (
            <StripePayment
              key={data.attemptId}
              id={id}
              clientSecret={data.clientSecret}
              publishableKey={data.publishableKey}
              amountMinor={data.amountMinor}
              refresh={refresh}
            />
          )
        ))}
      {(data || payment.isError) && (
        <Button variant="secondary" disabled={payment.isFetching} onClick={refresh}>
          {payment.isFetching ? 'Проверяем…' : 'Обновить статус оплаты'}
        </Button>
      )}
      {orderState === 'HELD' && (
        <p className="payment-note">
          Оплата должна быть подтверждена до окончания брони. Если подтверждение придёт позже,
          вернём полную сумму.
        </p>
      )}
    </section>
  );
}

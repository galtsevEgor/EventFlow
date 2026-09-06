'use client';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { unwrap } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';
import { money } from './client';
import type { BuyerApi } from './payment-panel';

type Outcome = 'success' | 'decline' | 'processing';
export function FakePayment({
  id,
  api,
  amountMinor,
  refresh,
}: {
  id: string;
  api: BuyerApi;
  amountMinor: number;
  refresh: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome>('success');
  const confirm = useMutation({
    mutationFn: async (result: Outcome) => {
      unwrap(
        await api.client.POST('/api/v1/orders/{id}/payment-attempt/fake-confirm', {
          params: { path: { id } },
          body: { outcome: result },
        }),
      );
      return result;
    },
    onSettled: refresh,
  });
  const awaiting =
    confirm.isPending || (confirm.isSuccess && confirm.data !== 'decline') || confirm.isError;
  return (
    <div className="payment-form">
      <p className="payment-badge">Демо-режим · без списания денег</p>
      <label>
        Результат демо-платежа
        <select
          value={outcome}
          disabled={awaiting}
          onChange={(event) => {
            setOutcome(event.target.value as Outcome);
            confirm.reset();
          }}
        >
          <option value="success">Успешная оплата</option>
          <option value="decline">Отклонение платежа</option>
          <option value="processing">Длительная обработка</option>
        </select>
      </label>
      <Button disabled={awaiting} onClick={() => confirm.mutate(outcome)}>
        {awaiting ? 'Ожидаем результат…' : `Оплатить ${money(amountMinor)} в демо`}
      </Button>
      {confirm.isSuccess && confirm.data === 'decline' && (
        <Alert>Демо-платёж отклонён. Деньги не списаны; можно повторить оплату.</Alert>
      )}
      {confirm.isError && (
        <Alert>Результат неизвестен. Обновите страницу, чтобы уточнить статус оплаты.</Alert>
      )}
    </div>
  );
}

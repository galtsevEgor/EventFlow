'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';
import { Alert, Button } from '@eventflow/ui';
import { formatPrice } from '../format';

const clients = new Map<string, ReturnType<typeof loadStripe>>();
function client(key: string) {
  let value = clients.get(key);
  if (!value) {
    value = loadStripe(key).catch(() => null);
    clients.set(key, value);
  }
  return value;
}
type Props = {
  id: string;
  clientSecret: string;
  publishableKey: string;
  amountMinor: number;
  refresh: () => void;
};
export default function StripePayment(props: Props) {
  const [stripe] = useState(() => client(props.publishableKey));
  return (
    <Elements
      stripe={stripe}
      options={{
        clientSecret: props.clientSecret,
        locale: 'ru',
        appearance: {
          theme: 'stripe',
          variables: { colorPrimary: '#285a45', borderRadius: '8px' },
        },
      }}
    >
      <Form id={props.id} amountMinor={props.amountMinor} refresh={props.refresh} />
    </Elements>
  );
}
function Form({ id, amountMinor, refresh }: Pick<Props, 'id' | 'amountMinor' | 'refresh'>) {
  const stripe = useStripe(),
    elements = useElements();
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setLoadFailed(true), 15000);
    return () => clearTimeout(timer);
  }, [ready]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || active.current) return;
    active.current = true;
    setBusy(true);
    setNotice('');
    try {
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${location.origin}/orders/${id}` },
        redirect: 'if_required',
      });
      if (result.error?.type === 'card_error' || result.error?.type === 'validation_error') {
        setNotice(result.error.message ?? 'Проверьте данные карты.');
        active.current = false;
        setBusy(false);
      } else setNotice('Уточняем результат на сервере. Повторно не оплачивайте.');
    } catch {
      setNotice('Ответ не получен. Уточняем результат на сервере; повторно не оплачивайте.');
    } finally {
      refresh();
    }
  }
  return (
    <form className="payment-form" onSubmit={(event) => void submit(event)}>
      <p className="payment-badge">Stripe sandbox · только тестовые карты</p>
      <PaymentElement
        onReady={() => {
          setReady(true);
          setLoadFailed(false);
        }}
        onLoadError={() => setLoadFailed(true)}
      />
      <Button type="submit" disabled={!stripe || !elements || !ready || busy}>
        {busy ? 'Проверяем оплату…' : `Оплатить ${formatPrice(amountMinor)}`}
      </Button>
      {notice && <Alert>{notice}</Alert>}
      {loadFailed && (
        <Alert>
          Форма Stripe не загрузилась. Обновите страницу или попробуйте другой браузер.{' '}
          <Button variant="secondary" onClick={() => location.reload()}>
            Обновить страницу
          </Button>
        </Alert>
      )}
    </form>
  );
}

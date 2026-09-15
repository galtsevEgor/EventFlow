'use client';

import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unwrap, type createApiClient, type Schemas } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';

type BuyerApi = ReturnType<typeof createApiClient>;

function ManualCode({
  api,
  buyer,
  orderId,
  ticketId,
}: {
  api: BuyerApi;
  buyer: string;
  orderId: string;
  ticketId: string;
}) {
  const code = useQuery({
    queryKey: ['ticket-code', buyer, orderId, ticketId],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.client.GET('/api/v1/orders/{id}/tickets/{ticketId}/code', {
          params: { path: { id: orderId, ticketId } },
          cache: 'no-store',
          signal,
        }),
      ).code,
    gcTime: 0,
    staleTime: Infinity,
  });
  const [feedback, setFeedback] = useState('');
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback('Код скопирован.');
    } catch {
      setFeedback('Выделите и скопируйте код вручную.');
    }
  }
  if (code.isPending) return <p role="status">Загружаем код…</p>;
  if (code.isError)
    return (
      <Alert>
        Код не загрузился. <Button onClick={() => void code.refetch()}>Повторить</Button>
      </Alert>
    );
  return (
    <div className="buyer-ticket-code">
      <p>Покажите код сотруднику, если QR не считывается.</p>
      <code>{code.data}</code>
      <Button variant="secondary" onClick={() => void copy(code.data)}>
        Скопировать код
      </Button>
      <p role="status">{feedback}</p>
    </div>
  );
}

function Ticket({
  orderId,
  ticket,
  api,
  buyer,
}: {
  orderId: string;
  ticket: Schemas['OrderTicket'];
  api: BuyerApi;
  buyer: string;
}) {
  const [showQr, setShowQr] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const seat = `Ряд ${ticket.row}, место ${ticket.number}`;

  return (
    <li className="buyer-ticket">
      <h3>{seat}</h3>
      <p>{ticket.categoryName}</p>
      <Button
        variant="secondary"
        aria-expanded={showQr}
        aria-label={`${showQr ? 'Скрыть QR' : 'Показать QR'}: ${seat}`}
        onClick={() => setShowQr(!showQr)}
      >
        {showQr ? 'Скрыть QR' : 'Показать QR'}
      </Button>
      {showQr &&
        (imageFailed ? (
          <Alert>
            QR не загрузился. <Button onClick={() => setImageFailed(false)}>Повторить</Button>
          </Alert>
        ) : (
          <img
            className="buyer-ticket-qr"
            src={`/api/v1/orders/${orderId}/tickets/${ticket.id}/qr`}
            alt={`QR для входа. ${seat}`}
            width={240}
            height={240}
            onError={() => setImageFailed(true)}
          />
        ))}
      <Button
        variant="secondary"
        aria-expanded={showCode}
        aria-label={`${showCode ? 'Скрыть код' : 'Показать код для ручного ввода'}: ${seat}`}
        onClick={() => setShowCode(!showCode)}
      >
        {showCode ? 'Скрыть код' : 'Показать код для ручного ввода'}
      </Button>
      {showCode && <ManualCode api={api} buyer={buyer} orderId={orderId} ticketId={ticket.id} />}
    </li>
  );
}

export function TicketsPanel({
  order,
  buyer,
  api,
}: {
  order: Schemas['Order'];
  buyer: string;
  api: BuyerApi;
}) {
  const headingId = useId();
  const tickets = useQuery({
    queryKey: ['tickets', order.id, buyer],
    queryFn: async ({ signal }) => {
      const response = await api.client.GET('/api/v1/orders/{id}/tickets', {
        params: { path: { id: order.id } },
        signal,
        cache: 'no-store',
      });
      if (response.response.status === 404) return null;
      if (!response.data) throw new Error('Не удалось загрузить билеты.');
      return response.data.tickets;
    },
    refetchInterval: (query) => (query.state.data === null && !query.state.error ? 3000 : false),
  });
  const event = useQuery({
    queryKey: ['ticket-event', order.saleId],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.client.GET('/api/v1/events/{id}', {
          params: { path: { id: order.saleId } },
          signal,
        }),
      ),
  });
  return (
    <section className="tickets-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>Билеты</h2>
      {event.data && (
        <p>
          <time dateTime={event.data.startsAt}>
            {new Intl.DateTimeFormat('ru', {
              dateStyle: 'long',
              timeStyle: 'short',
              timeZone: event.data.timeZone,
            }).format(new Date(event.data.startsAt))}
          </time>
          {' · '}
          {event.data.city}, {event.data.address}
        </p>
      )}
      {tickets.isError ? (
        <Alert>
          Не удалось загрузить билеты.{' '}
          <Button onClick={() => void tickets.refetch()}>Повторить</Button>
        </Alert>
      ) : tickets.data ? (
        <>
          <p>Покажите QR своего места на входе.</p>
          <ul className="buyer-tickets">
            {tickets.data.map((ticket) => (
              <Ticket key={ticket.id} ticket={ticket} orderId={order.id} api={api} buyer={buyer} />
            ))}
          </ul>
        </>
      ) : (
        <p role="status">Готовим билеты…</p>
      )}
    </section>
  );
}

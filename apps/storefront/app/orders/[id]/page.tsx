import { notFound } from 'next/navigation';
import { OrderDetails } from '../../booking/order-details';
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) notFound();
  return <OrderDetails id={id} />;
}

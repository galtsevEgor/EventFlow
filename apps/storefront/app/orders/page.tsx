import { OrderList } from '../booking/order-list';
export default function OrdersPage() {
  return (
    <>
      <div className="account-page-heading">
        <h1>Мои заказы</h1>
      </div>
      <OrderList />
    </>
  );
}

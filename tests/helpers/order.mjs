export async function ageOrder(db, id, expiresAt = new Date(Date.now() - 1)) {
  await db.$transaction(async (tx) => {
    await tx.order.update({
      where: { id },
      data: { createdAt: new Date(+expiresAt - 600000), expiresAt },
    });
    await tx.seatInventory.updateMany({ where: { currentOrderId: id }, data: { expiresAt } });
  });
}

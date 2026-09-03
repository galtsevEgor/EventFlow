import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Loading, Select } from './index';

const meta = { title: 'EventFlow/Primitives', component: Button } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Primary: Story = { args: { children: 'Создать организацию' } };
export const Pending: Story = { args: { children: 'Сохранение…', disabled: true } };
export const States: Story = {
  render: () => (
    <div style={{ maxWidth: 520, fontFamily: 'Arial', display: 'grid', gap: 16 }}>
      <Field label="Название" defaultValue="Вечерняя сцена" />
      <Field label="Email" error="Укажите корректный email" defaultValue="invalid" />
      <Select label="Роль">
        <option>Менеджер</option>
        <option>Сотрудник</option>
      </Select>
      <Badge>Владелец</Badge>
      <Alert>Не удалось сохранить. Повторите попытку.</Alert>
      <Loading />
      <EmptyState title="Пока нет мероприятий">Создайте первый черновик.</EmptyState>
    </div>
  ),
};
function DialogExample() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Открыть диалог</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Новое мероприятие"
        description="Сохраните название первого черновика."
      >
        <Field label="Название мероприятия" />
        <Button onClick={() => setOpen(false)}>Сохранить</Button>
      </Dialog>
    </>
  );
}
export const Modal: Story = { render: () => <DialogExample /> };

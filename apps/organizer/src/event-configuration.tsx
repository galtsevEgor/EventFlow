import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Field } from '@eventflow/ui';
import { api, unwrap, type Schemas } from './api';
import { invalidateEventList } from './event-queries';
import { ErrorMessage } from './feedback';
import { EventSchedule, dateLabels, type DateField, type Schedule } from './event-schedule';
import { localTimeToUtc, parsePrice, utcToLocal } from './event-time';
import { SeatGrid } from './seat-grid';

const dateFields = Object.keys(dateLabels) as DateField[];
type Category = { id: string; name: string; price: string };
function initialSchedule(config: Schemas['EventConfiguration'] | null): Schedule {
  return Object.fromEntries(
    dateFields.map((field) => [
      field,
      config ? utcToLocal(config[field], config.timeZone) : { value: '', offset: '' },
    ]),
  ) as Schedule;
}

export function EventConfiguration({
  id,
  event,
  onSaved,
}: {
  id: string;
  event: Schemas['Draft'];
  onSaved: () => void;
}) {
  const initial = event.configuration;
  const [city, setCity] = useState(initial?.city ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [timeZone, setTimeZone] = useState(initial?.timeZone ?? 'Europe/Chisinau');
  const [schedule, setSchedule] = useState(() => initialSchedule(initial));
  const [categories, setCategories] = useState<Category[]>(
    () =>
      initial?.categories.map((category) => ({
        id: category.id,
        name: category.name,
        price: (category.priceMinor / 100).toFixed(2),
      })) ?? [{ id: 'standard', name: 'Стандарт', price: '15.00' }],
  );
  const [layout, setLayout] = useState<Schemas['EventConfiguration']['layout']>(
    initial?.layout ?? { rows: 5, columns: 10, defaultCategoryId: 'standard', overrides: [] },
  );
  const [validation, setValidation] = useState('');
  const save = useMutation({
    mutationFn: async (configuration: Schemas['EventConfiguration']) =>
      unwrap(
        await api.client.PUT('/api/v1/organizations/{id}/events/{eventId}/configuration', {
          params: { path: { id, eventId: event.id } },
          body: { revision: event.revision, configuration },
        }),
      ),
    onSuccess: async () => {
      await invalidateEventList(id);
      onSaved();
    },
  });
  function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    setValidation('');
    try {
      const dates = Object.fromEntries(
        dateFields.map((field) => {
          try {
            return [field, localTimeToUtc(schedule[field].value, timeZone, schedule[field].offset)];
          } catch (error) {
            throw new Error(
              `${dateLabels[field]}: ${error instanceof Error ? error.message : 'Проверьте дату.'}`,
              { cause: error },
            );
          }
        }),
      ) as Record<DateField, string>;
      save.mutate({
        city,
        address,
        timeZone,
        ...dates,
        currency: 'EUR',
        layout,
        categories: categories.map((category) => ({
          id: category.id,
          name: category.name,
          priceMinor: parsePrice(category.price),
        })),
      });
    } catch (error) {
      setValidation(error instanceof Error ? error.message : 'Проверьте заполненные поля.');
    }
  }
  function removeCategory(id: string) {
    const remaining = categories.filter((category) => category.id !== id);
    const replacement = remaining[0]?.id;
    if (!replacement) return;
    setCategories(remaining);
    setLayout({
      ...layout,
      defaultCategoryId: layout.defaultCategoryId === id ? replacement : layout.defaultCategoryId,
      overrides: layout.overrides.map((seat) =>
        seat.categoryId === id ? { ...seat, categoryId: replacement } : seat,
      ),
    });
  }
  return (
    <form className="configuration-form" onSubmit={submit}>
      <fieldset disabled={save.isPending} className="configuration-fields">
        <fieldset className="configuration-section">
          <legend>Место проведения</legend>
          <div className="schedule-fields">
            <Field
              label="Город"
              required
              minLength={2}
              maxLength={100}
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
            <Field
              label="Адрес площадки"
              required
              minLength={5}
              maxLength={250}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <Field
            label="Часовой пояс IANA"
            required
            value={timeZone}
            list="event-timezones"
            onChange={(e) => {
              setTimeZone(e.target.value);
              setSchedule(
                Object.fromEntries(
                  dateFields.map((field) => [field, { ...schedule[field], offset: '' }]),
                ) as Schedule,
              );
            }}
          />
          <datalist id="event-timezones">
            <option value="Europe/Chisinau" />
            <option value="Europe/Bucharest" />
            <option value="Europe/Berlin" />
            <option value="UTC" />
          </datalist>
        </fieldset>
        <fieldset className="configuration-section">
          <legend>Расписание</legend>
          <p className="muted">
            Все даты вводятся в часовом поясе площадки. Продажи заканчиваются не позже начала
            мероприятия.
          </p>
          <EventSchedule
            zone={timeZone}
            schedule={schedule}
            onChange={(field, date) => setSchedule({ ...schedule, [field]: date })}
          />
        </fieldset>
        <fieldset className="configuration-section">
          <legend>Категории цен · EUR</legend>
          {categories.map((category, index) => (
            <div className="category-row" key={category.id}>
              <Field
                label={`Категория ${index + 1}`}
                required
                maxLength={60}
                value={category.name}
                onChange={(e) =>
                  setCategories(
                    categories.map((item) =>
                      item.id === category.id ? { ...item, name: e.target.value } : item,
                    ),
                  )
                }
              />
              <Field
                label={`Цена категории ${index + 1}, EUR`}
                required
                inputMode="decimal"
                value={category.price}
                onChange={(e) =>
                  setCategories(
                    categories.map((item) =>
                      item.id === category.id ? { ...item, price: e.target.value } : item,
                    ),
                  )
                }
              />
              <Button
                variant="secondary"
                disabled={categories.length === 1}
                aria-label={`Удалить категорию ${index + 1}`}
                onClick={() => removeCategory(category.id)}
              >
                Удалить
              </Button>
            </div>
          ))}
          <p className="muted">
            При удалении категории её места перейдут в первую оставшуюся категорию.
          </p>
          <Button
            variant="secondary"
            disabled={categories.length >= 20}
            onClick={() =>
              setCategories([
                ...categories,
                {
                  id: `category-${crypto.randomUUID().slice(0, 8)}`,
                  name: `Категория ${categories.length + 1}`,
                  price: '20.00',
                },
              ])
            }
          >
            Добавить категорию
          </Button>
        </fieldset>
        <SeatGrid
          layout={layout}
          categories={categories}
          onChange={setLayout}
          disabled={save.isPending}
        />
        {validation && <Alert>{validation}</Alert>}
        <ErrorMessage error={save.error} />
        <Button type="submit" disabled={save.isPending}>
          Сохранить настройки
        </Button>
      </fieldset>
    </form>
  );
}

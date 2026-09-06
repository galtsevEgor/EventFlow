import { Field, Select } from '@eventflow/ui';
import { localTimeChoices } from './event-time';

export const dateLabels = {
  startsAt: 'Начало мероприятия',
  endsAt: 'Окончание мероприятия',
  salesStartsAt: 'Начало продаж',
  salesEndsAt: 'Окончание продаж',
  admissionStartsAt: 'Открытие входа',
  admissionEndsAt: 'Закрытие входа',
} as const;
export type DateField = keyof typeof dateLabels;
export type LocalDate = { value: string; offset: string };
export type Schedule = Record<DateField, LocalDate>;

export function EventSchedule({
  zone,
  schedule,
  onChange,
}: {
  zone: string;
  schedule: Schedule;
  onChange: (field: DateField, value: LocalDate) => void;
}) {
  return (
    <div className="schedule-fields">
      {(Object.keys(dateLabels) as DateField[]).map((field) => (
        <LocalDateField
          key={field}
          label={dateLabels[field]}
          date={schedule[field]}
          zone={zone}
          onChange={(date) => onChange(field, date)}
        />
      ))}
    </div>
  );
}

function LocalDateField({
  label,
  date,
  zone,
  onChange,
}: {
  label: string;
  date: LocalDate;
  zone: string;
  onChange: (value: LocalDate) => void;
}) {
  let choices: ReturnType<typeof localTimeChoices> = [];
  let error: string | undefined;
  if (date.value)
    try {
      choices = localTimeChoices(date.value, zone);
      if (choices.length === 0) error = 'Этого времени нет из-за перевода часов.';
    } catch {
      error = 'Проверьте дату и часовой пояс.';
    }
  return (
    <div>
      <Field
        label={label}
        type="datetime-local"
        required
        value={date.value}
        error={error}
        onChange={(event) => onChange({ value: event.target.value, offset: '' })}
      />
      {choices.length > 1 && (
        <Select
          label={`${label}: смещение UTC`}
          required
          value={date.offset}
          onChange={(event) => onChange({ ...date, offset: event.target.value })}
        >
          <option value="">Время встречается дважды — выберите</option>
          {choices.map((choice) => (
            <option key={choice.offset} value={choice.offset}>
              UTC{choice.offset}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

import { z } from 'zod';

const instant = z.iso.datetime();
const categoryId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/);
export const configurationSchema = z
  .strictObject({
    city: z.string().trim().min(2).max(100),
    address: z.string().trim().min(5).max(250),
    timeZone: z
      .string()
      .max(100)
      .refine((value) => {
        if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return false;
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Укажите существующий часовой пояс IANA.'),
    startsAt: instant,
    endsAt: instant,
    salesStartsAt: instant,
    salesEndsAt: instant,
    admissionStartsAt: instant,
    admissionEndsAt: instant,
    currency: z.literal('EUR'),
    categories: z
      .array(
        z.strictObject({
          id: categoryId,
          name: z.string().trim().min(1).max(60),
          priceMinor: z.number().int().positive().max(100_000_000),
        }),
      )
      .min(1)
      .max(20),
    layout: z.strictObject({
      rows: z.number().int().min(1).max(50),
      columns: z.number().int().min(1).max(50),
      defaultCategoryId: categoryId,
      overrides: z
        .array(
          z.strictObject({
            row: z.number().int().min(1),
            number: z.number().int().min(1),
            categoryId,
            disabled: z.boolean(),
          }),
        )
        .max(1000),
    }),
  })
  .superRefine((value, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const time = (
      field:
        | 'startsAt'
        | 'endsAt'
        | 'salesStartsAt'
        | 'salesEndsAt'
        | 'admissionStartsAt'
        | 'admissionEndsAt',
    ) => Date.parse(value[field]);
    if (time('startsAt') >= time('endsAt'))
      issue(['endsAt'], 'Окончание должно быть позже начала события.');
    if (time('salesStartsAt') >= time('salesEndsAt') || time('salesEndsAt') > time('startsAt'))
      issue(
        ['salesEndsAt'],
        'Продажи должны закончиться после своего начала и не позже начала события.',
      );
    if (
      time('admissionStartsAt') > time('startsAt') ||
      time('admissionEndsAt') < time('startsAt') ||
      time('admissionEndsAt') > time('endsAt') ||
      time('admissionStartsAt') >= time('admissionEndsAt')
    )
      issue(
        ['admissionEndsAt'],
        'Проверьте окно допуска: оно должно включать начало события и заканчиваться не позже его окончания.',
      );
    const categories = new Set(value.categories.map((category) => category.id));
    if (categories.size !== value.categories.length)
      issue(['categories'], 'Идентификаторы категорий должны быть уникальны.');
    const { rows, columns, defaultCategoryId, overrides } = value.layout;
    if (rows * columns > 1000) issue(['layout', 'rows'], 'Максимум 1 000 мест в схеме.');
    if (!categories.has(defaultCategoryId))
      issue(['layout', 'defaultCategoryId'], 'Категория не найдена.');
    const seats = new Set<string>();
    overrides.forEach((seat, index) => {
      const key = `${seat.row}:${seat.number}`;
      if (seats.has(key)) issue(['layout', 'overrides', index], 'Место указано повторно.');
      seats.add(key);
      if (seat.row > rows || seat.number > columns)
        issue(['layout', 'overrides', index], 'Место выходит за границы схемы.');
      if (!categories.has(seat.categoryId))
        issue(['layout', 'overrides', index, 'categoryId'], 'Категория не найдена.');
    });
    if (overrides.filter((seat) => seat.disabled).length >= rows * columns)
      issue(['layout'], 'Оставьте хотя бы одно доступное место.');
  });
export type EventConfiguration = z.infer<typeof configurationSchema>;

export function materializeSeats(configuration: EventConfiguration) {
  const { rows, columns, defaultCategoryId, overrides } = configuration.layout;
  const changes = new Map(overrides.map((seat) => [`${seat.row}:${seat.number}`, seat]));
  const categories = new Map(configuration.categories.map((category) => [category.id, category]));
  const seats = [];
  for (let row = 1; row <= rows; row++)
    for (let number = 1; number <= columns; number++) {
      const override = changes.get(`${row}:${number}`);
      if (override?.disabled) continue;
      const category = categories.get(override?.categoryId ?? defaultCategoryId);
      if (!category) throw new Error('Validated seat category is missing');
      seats.push({
        seatId: `r${row}-s${number}`,
        row,
        number,
        categoryId: category.id,
        categoryName: category.name,
        priceMinor: category.priceMinor,
      });
    }
  return seats;
}

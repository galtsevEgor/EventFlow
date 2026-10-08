import { createHash } from 'node:crypto';

export function operationVersion(
  ...values: (string | number | boolean | Date | null | undefined)[]
) {
  return createHash('sha256')
    .update(JSON.stringify(values.map((value) => value ?? null)))
    .digest('hex');
}

type Filter = {
  limit: number;
  kind?: string | undefined;
  orderId?: string | undefined;
  cursor?: { at: string; kind: string; id: string } | undefined;
};
type Query = <T>(sql: string, ...values: unknown[]) => Promise<T>;

export function queryOperatorPage<T>(query: Query, sourceSql: string, filter: Filter) {
  return query<T[]>(
    `WITH issues AS (${sourceSql}) SELECT * FROM issues
    WHERE ($1::text IS NULL OR kind=$1) AND ($2::text IS NULL OR "orderId"=$2)
    AND ($3::timestamptz IS NULL OR (at,kind,id)>($3::timestamptz,$4::text,$5::text))
    ORDER BY at,kind,id LIMIT $6`,
    filter.kind ?? null,
    filter.orderId ?? null,
    filter.cursor?.at ?? null,
    filter.cursor?.kind ?? null,
    filter.cursor?.id ?? null,
    filter.limit + 1,
  );
}

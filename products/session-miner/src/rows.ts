import { z } from "zod";

/** Validates rows read from SQLite against the schema their query promises, so a drifted column fails loudly here. */
export function parseRows<S extends z.ZodType>(
  schema: S,
  rows: readonly unknown[]
): z.output<S>[] {
  return rows.map((row) => schema.parse(row));
}

/** The single-row form: `undefined` passes through, since `.get()` returns it for no match. */
export function parseRow<S extends z.ZodType>(
  schema: S,
  row: unknown
): z.output<S> | undefined {
  return row === undefined ? undefined : schema.parse(row);
}

export const countRow = z.object({ n: z.number() });

/** The `code` of a Node system error, read without assuming the thrown value is one. */
export function errnoCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? err.code
    : undefined;
}

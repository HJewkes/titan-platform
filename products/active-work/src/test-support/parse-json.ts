import type { z } from 'zod';

/** Parse JSON text and validate its shape, so a test reads typed fields without asserting them. */
export function parseJson<S extends z.ZodType>(text: string, schema: S): z.output<S> {
  return schema.parse(JSON.parse(text));
}

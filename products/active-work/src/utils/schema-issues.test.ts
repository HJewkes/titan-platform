import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatIssues } from './schema-issues.js';

function failure(schema: z.ZodType, value: unknown): z.ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('expected the schema to reject the value');
  return result.error;
}

describe('formatIssues', () => {
  it('joins the dotted path of a nested field to its message', () => {
    const schema = z.object({ outer: z.object({ inner: z.number() }) });

    const text = formatIssues(failure(schema, { outer: { inner: 'x' } }));

    expect(text).toMatch(/^outer\.inner: .+/);
    expect(text).not.toContain('[{');
  });

  it('writes an array index as a path segment', () => {
    const schema = z.object({ tags: z.array(z.string()) });

    const text = formatIssues(failure(schema, { tags: ['a', 3] }));

    expect(text).toMatch(/^tags\.1: .+/);
  });

  it('shows a root refine issue as (root)', () => {
    const schema = z.object({ a: z.number() }).refine(() => false, { message: 'never valid' });

    const text = formatIssues(failure(schema, { a: 1 }));

    expect(text).toBe('(root): never valid');
  });

  it('separates several issues with a semicolon', () => {
    const schema = z.object({ a: z.number(), b: z.number() });

    const text = formatIssues(failure(schema, { a: 'x', b: 'y' }));

    expect(text.split('; ')).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import { UsageError } from '../errors.js';
import { pageList } from './_list-page.js';

const items = ['a', 'b', 'c', 'd', 'e'];

describe('pageList', () => {
  it('returns the first page with a next cursor', () => {
    const page = pageList(items, { limit: 2 });
    expect(page).toMatchObject({ items: ['a', 'b'], total: 5, truncated: true });
    expect(page.next_cursor).toEqual(expect.any(String));
  });

  it('returns a middle page when given the previous cursor', () => {
    const first = pageList(items, { limit: 2 });
    const page = pageList(items, { limit: 2, cursor: first.next_cursor ?? undefined });
    expect(page).toMatchObject({ items: ['c', 'd'], total: 5, truncated: true });
    expect(page.next_cursor).not.toBeNull();
  });

  it('returns the last page with a null next cursor', () => {
    const first = pageList(items, { limit: 2 });
    const second = pageList(items, { limit: 2, cursor: first.next_cursor ?? undefined });
    const last = pageList(items, { limit: 2, cursor: second.next_cursor ?? undefined });
    expect(last).toEqual({ items: ['e'], total: 5, truncated: false, next_cursor: null });
  });

  it('returns everything when limit is omitted', () => {
    expect(pageList(items, {})).toEqual({ items, total: 5, truncated: false, next_cursor: null });
  });

  it('handles an empty list', () => {
    expect(pageList([], { limit: 3 })).toEqual({
      items: [],
      total: 0,
      truncated: false,
      next_cursor: null,
    });
  });

  it.each([['not-a-cursor'], [Buffer.from('99', 'utf8').toString('base64url')], [Buffer.from('-1', 'utf8').toString('base64url')]])(
    'rejects the bad cursor %s',
    (cursor) => {
      expect(() => pageList(items, { limit: 2, cursor })).toThrow(UsageError);
    },
  );
});

import { describe, expect, it } from 'vitest';
import { parsePlan } from './_task-apply-plan.js';

const GOOD_SET_OPS: Array<[string, unknown]> = [
  ['set_bet', 'sample/B1'],
  ['set_estimate', 2.5],
  ['set_fold', 'sample/FD1'],
  ['set_fold', 'independent'],
  ['set_kind', 'feature'],
  ['set_cos', 'standard'],
  ['set_area', 'active-work'],
  ['set_due', '2026-12-31'],
];

const BAD_SET_OPS: Array<[string, unknown]> = [
  ['set_bet', 'not a bet'],
  ['set_estimate', 0],
  ['set_estimate', '2'],
  ['set_fold', 'nope'],
  ['set_kind', ''],
  ['set_cos', 5],
  ['set_area', ''],
  ['set_due', '+3d'],
];

function lineWith(op: unknown): string {
  return JSON.stringify({ slug: 'sample', id: 'SA-1', ops: [op] });
}

describe('parsePlan on set_<field> ops', () => {
  it.each(GOOD_SET_OPS)('accepts %s with %j', (key, value) => {
    const { entries } = parsePlan(lineWith({ [key]: value }));

    expect(entries[0]?.error).toBeUndefined();
    expect(entries[0]?.ops).toEqual([{ op: key, value }]);
  });

  it.each(BAD_SET_OPS)('fails %s with %j and names the op', (key, value) => {
    const { entries } = parsePlan(lineWith({ [key]: value }));

    expect(entries[0]?.error).toContain(key);
  });

  it('lists the valid ops when an op is unknown', () => {
    const { entries } = parsePlan(lineWith({ frobnicate: 1 }));

    expect(entries[0]?.error).toMatch(/^Unknown op: frobnicate \(valid: add_tag, .*set_due/);
  });
});

describe('parsePlan on lines that are not objects', () => {
  it.each(['null', '[]', '7', '"text"'])('fails line %s and keeps the next one', (line) => {
    const { entries } = parsePlan(`${line}\n{"slug":"sample","id":"SA-1","ops":[]}\n`);

    expect(entries[0]?.error).toBe('Plan line must be a JSON object');
    expect(entries[1]?.error).toBeUndefined();
  });

  it('reports unparseable JSON as its own failure', () => {
    const { entries } = parsePlan('{nope\n');

    expect(entries[0]?.error).toMatch(/^Invalid JSON/);
  });
});

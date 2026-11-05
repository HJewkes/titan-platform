import { describe, expect, it } from 'vitest';
import { parsePlan } from '../../src/commands/_task-apply-plan.js';

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

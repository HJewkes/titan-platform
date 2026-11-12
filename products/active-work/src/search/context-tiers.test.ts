import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hitTiers, seeLine } from './context-tiers.js';
import type { RelatedHit } from './related.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-tiers-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hitOver(overrides: Partial<RelatedHit>): RelatedHit {
  return {
    ref: 'note:x/lighthouse.md',
    class: 'notes',
    initiative: 'x',
    title: 'The lamp',
    path: null,
    excerpt: null,
    byteOffset: null,
    byteLength: null,
    ...overrides,
  };
}

function spanHit(file: string, byteOffset: number, byteLength: number): RelatedHit {
  return hitOver({ path: file, byteOffset, byteLength });
}

describe('hitTiers', () => {
  it('tier 0 is the ref and quoted title, tier 1 adds the excerpt', async () => {
    const hit = hitOver({ excerpt: 'Wick trimmed at dusk.' });

    const tiers = await hitTiers(hit, dir);

    expect(tiers).toEqual([
      'note:x/lighthouse.md "The lamp"',
      'note:x/lighthouse.md "The lamp"\nWick trimmed at dusk.',
    ]);
  });

  it('tier 2 reads exactly byteLength bytes at byteOffset', async () => {
    const file = path.join(dir, 'span.md');
    writeFileSync(file, 'HEADER-SPANTEXT-TRAILER');

    const tiers = await hitTiers(spanHit(file, 7, 8), dir);

    expect(tiers[2]).toBe(`${seeLine(hitOver({}))}\nSPANTEXT`);
  });

  it('span text is capped at 2,000 characters', async () => {
    const file = path.join(dir, 'long.md');
    writeFileSync(file, 'a'.repeat(5000));

    const tiers = await hitTiers(spanHit(file, 0, 5000), dir);

    expect(tiers[2]).toHaveLength(seeLine(hitOver({})).length + 1 + 2000);
  });

  it('a missing file leaves two tiers and does not throw', async () => {
    const tiers = await hitTiers(spanHit(path.join(dir, 'gone.md'), 0, 10), dir);

    expect(tiers).toHaveLength(2);
  });
});

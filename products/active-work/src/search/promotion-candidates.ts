import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getStateRoot } from '../utils/paths.js';

interface PromotionCandidate {
  ref: string;
  renders: number;
  initiatives: number;
}

const MIN_RENDERS = 3;
const MIN_INITIATIVES = 2;
const NOTE_PREFIX = 'note:';

const HitSchema = z.object({ ref: z.string(), slug: z.string(), ts: z.string() });

interface RefTally {
  renders: Set<string>;
  initiatives: Set<string>;
}

function defaultLogFile(): string {
  return path.join(getStateRoot(), 'retrieval-hits.jsonl');
}

async function readLines(file: string): Promise<string[]> {
  try {
    return (await fs.readFile(file, 'utf8')).split('\n');
  } catch {
    return [];
  }
}

function parseHit(line: string): { ref: string; slug: string; ts: string } | null {
  try {
    const parsed = HitSchema.safeParse(JSON.parse(line));
    return parsed.success && parsed.data.ref.startsWith(NOTE_PREFIX) ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Notes the hit log shows surfacing in enough renders across enough
 * initiatives to be worth promoting. A render is one distinct (slug, ts); the
 * several hits one render logs count once. Unreadable lines are skipped.
 */
export async function promotionCandidates(
  file: string = defaultLogFile(),
): Promise<PromotionCandidate[]> {
  const tallies = new Map<string, RefTally>();
  for (const line of await readLines(file)) {
    const hit = parseHit(line);
    if (!hit) continue;
    const tally = tallies.get(hit.ref) ?? { renders: new Set(), initiatives: new Set() };
    tally.renders.add(`${hit.slug}\u0000${hit.ts}`);
    tally.initiatives.add(hit.slug);
    tallies.set(hit.ref, tally);
  }
  return [...tallies]
    .map(([ref, t]) => ({ ref, renders: t.renders.size, initiatives: t.initiatives.size }))
    .filter((c) => c.renders >= MIN_RENDERS && c.initiatives >= MIN_INITIATIVES)
    .sort((a, b) => b.renders - a.renders || a.ref.localeCompare(b.ref));
}

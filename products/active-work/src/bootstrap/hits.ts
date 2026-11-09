import { nowIso } from '../utils/today.js';
import type { HitLogEntry, HitLogWriter } from '../search/hit-log.js';
import type { OpenLoop } from '../sessions/open-loops.js';
import type { NoteRanking } from './rank-notes.js';
import type { LoopContext } from './loop-context.js';
import { DURABLE_NOTES_LIMIT } from './render-notes-loops.js';

/** Refs the notes sections print, so a loop's `see:` lines never repeat them. */
export function shownNoteRefs(ranking: NoteRanking, slug: string): string[] {
  const local = ranking.local
    .slice(0, DURABLE_NOTES_LIMIT)
    .map((note) => `note:${slug}/${note.filename}`);
  return [...local, ...ranking.foreign.map((note) => note.ref)];
}

interface RenderedHits {
  slug: string;
  loops: OpenLoop[];
  labels: string[];
  loopContext: LoopContext;
  noteRanking: NoteRanking;
  subject: string;
}

/** One log line per hit the prompt shows, in the order it shows them. */
function hitLogEntries(input: RenderedHits, ts: string): HitLogEntry[] {
  const { slug } = input;
  const loopEntries = input.loops.flatMap((loop, i) =>
    (input.loopContext.hits.get(loop.ref) ?? []).map((hit) => ({
      ts,
      slug,
      trigger: 'bootstrap-loop' as const,
      query: input.labels[i],
      ref: hit.ref,
      rank: hit.rank,
      byteOffset: hit.byteOffset,
      byteLength: hit.byteLength,
    })),
  );
  const foreignEntries = input.noteRanking.foreign.map((note, i) => ({
    ts,
    slug,
    trigger: 'bootstrap-foreign' as const,
    query: input.subject,
    ref: note.ref,
    rank: i + 1,
    byteOffset: null,
    byteLength: null,
  }));
  return [...loopEntries, ...foreignEntries];
}

/** Everything that made retrieval show less, as one readable line each. */
export async function retrievalDegradations(input: RenderedHits, hitLog: HitLogWriter): Promise<string[]> {
  const degraded = input.loopContext.degraded.map(
    (entry) => `${entry.source}: ${entry.reason} (${entry.message})`,
  );
  const failure = await hitLog(hitLogEntries(input, nowIso()));
  if (failure !== null) degraded.push(`hit-log: error (${failure})`);
  return degraded;
}

import { isRecord } from "@titan-design/rpc-protocol/narrow";
import type { L0Result } from "../eval-l0.js";
import type { ScriptV1 } from "../script-schema.js";

/**
 * A chapter repair round re-emits only the beats its failing rows name, so its output is those beats rather than the
 * whole chapter. A row naming the chapter itself has no beat to point at: Q-W3, Q-W4 and Q-W6 when the chapter lacks
 * the beat they read, Q-W10 always, and Q-V4 for a chapter label read as "Chapter ...". That round re-emits the chapter.
 */
export function patchTargets(rows: readonly L0Result[], chapter: ScriptV1): string[] | undefined {
  const id = chapter.chapters[0]!.id;
  if (rows.some((row) => row.detail_beats.includes(id))) return undefined;
  const named = new Set(rows.flatMap((row) => row.detail_beats));
  const beats = chapter.beats.map((beat) => beat.id).filter((beat) => named.has(beat));
  return beats.length > 0 ? beats : undefined;
}

/** What a patch round asks for in place of the whole corrected chapter. */
export const patchTask = (targets: readonly string[]): string =>
  `Reply with one JSON object and nothing else: "beats" lists exactly the beats ${targets.join(", ")}, in that order, each one whole and keeping its id and chapter; every other beat stays as drafted and is left out. No beat is added, split or removed. "glossary" lists only entries for names a changed beat introduces that the glossary lacks, and is left out when there are none. No other field.\n`;

function idFault(ids: readonly unknown[], targets: readonly string[]): string | undefined {
  const wanted = new Set(targets);
  const extra = ids.filter((id) => typeof id !== "string" || !wanted.has(id)).map(String);
  const missing = targets.filter((id) => !ids.includes(id));
  const repeated = ids.length !== new Set(ids).size;
  if (extra.length === 0 && missing.length === 0 && !repeated) return undefined;
  const parts = [extra.length > 0 && `names beats it was not asked for: ${extra.join(", ")}`, missing.length > 0 && `leaves out ${missing.join(", ")}`, repeated && "repeats a beat id"];
  return `beats: the reply must hold exactly ${targets.join(", ")}; it ${parts.filter(Boolean).join("; ")}`;
}

/**
 * The patch spliced into the chapter: each named beat replaced in place, keeping its id, chapter and position, every
 * other beat as it was, and the glossary entries it adds appended. A reply naming any other set of beats is refused.
 */
export function splicePatch(reply: Record<string, unknown>, chapter: ScriptV1, targets: readonly string[]): { raw: Record<string, unknown> } | { error: string } {
  if (!Array.isArray(reply.beats) || !reply.beats.every(isRecord)) return { error: 'the reply holds no "beats" array of beat objects' };
  const patch: Record<string, unknown>[] = reply.beats;
  const fault = idFault(patch.map((beat) => beat.id), targets);
  if (fault) return { error: fault };
  const byId = new Map(patch.map((beat) => [beat.id, beat]));
  const beats = chapter.beats.map((beat) => (byId.has(beat.id) ? { ...byId.get(beat.id), id: beat.id, chapter: beat.chapter } : beat));
  const known = new Set(chapter.video.glossary.map((entry) => entry.name.toLowerCase()));
  const added = (Array.isArray(reply.glossary) ? reply.glossary : []).filter((entry) => !(isRecord(entry) && typeof entry.name === "string" && known.has(entry.name.toLowerCase())));
  const video = { ...chapter.video, glossary: [...chapter.video.glossary, ...added] };
  return { raw: structuredClone({ ...chapter, video, beats }) };
}

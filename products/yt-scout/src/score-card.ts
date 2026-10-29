import { z } from "zod";

export const PAIN_POINTS = [
  "load",
  "permissions",
  "context",
  "review",
  "model-mix",
  "session-mining",
  "evals",
  "typescript",
  "agent-ux",
  "mcp",
  "factory-design",
] as const;

const Axis = z.int().min(0).max(5);

export const ScoreCardSchema = z.strictObject({
  actionable: Axis,
  novelty: Axis,
  evidence: Axis,
  pain_points: z.array(z.enum(PAIN_POINTS)),
  summary: z.string().min(1),
  techniques: z.array(z.strictObject({ ts: z.string().min(1), what: z.string().min(1) })).max(4),
  caveat: z.string(),
});

export type ScoreCard = z.infer<typeof ScoreCardSchema>;
export type Technique = ScoreCard["techniques"][number];

export const totalOf = (card: Pick<ScoreCard, "actionable" | "novelty" | "evidence">): number =>
  card.actionable + card.novelty + card.evidence;

const ANCHOR = /\[(?:(\d+):)?(\d+):(\d{2})\]/g;

/** Anchors are `[m:ss]` or `[h:mm:ss]`; both sides are compared as whole seconds, so padding does not matter. */
function toSeconds(hours: string | undefined, minutes: string, seconds: string): number {
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function transcriptAnchors(transcript: string): Set<number> {
  return new Set([...transcript.matchAll(ANCHOR)].map((m) => toSeconds(m[1], m[2]!, m[3]!)));
}

export interface TsCheck {
  kept: Technique[];
  dropped: Technique[];
}

/** A technique survives only when its ts is exactly one of the transcript's own anchors (plan section 3, step 5). */
export function checkTimestamps(techniques: Technique[], transcript: string): TsCheck {
  const anchors = transcriptAnchors(transcript);
  const kept: Technique[] = [];
  const dropped: Technique[] = [];
  for (const t of techniques) {
    const m = /^(?:(\d+):)?(\d+):(\d{2})$/.exec(t.ts);
    const ok = m !== null && anchors.has(toSeconds(m[1], m[2]!, m[3]!));
    (ok ? kept : dropped).push(t);
  }
  return { kept, dropped };
}

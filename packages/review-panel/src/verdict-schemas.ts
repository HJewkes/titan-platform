import { z } from "zod";
import { MAX_OWNER_BRIEF_CHARS, OWNER_BRIEF_END, OWNER_BRIEF_START, type MalformedRefusal } from "./reviewer-brief.js";

const Bullets = z.array(z.string().min(1).max(300)).min(1).max(5);

/** What the owner is asked about a gated PR, as the reviewer who read the diff wrote it. */
export const OwnerBriefSchema = z.strictObject({
  what: z.string().min(1).max(500),
  why: z.string().min(1).max(500),
  pros: Bullets,
  cons: Bullets,
  doorType: z.enum(["two-way", "one-way"]),
});

export type OwnerBrief = z.infer<typeof OwnerBriefSchema>;

type Draft = { what?: string; why?: string; door?: string; pros: string[]; cons: string[] };

/** Folds one body line into the draft; false when the line fits no field, so the block is malformed. */
function takeLine(draft: Draft, line: string, list: { current: string[] | null }): boolean {
  if (line === "") return true;
  const single = /^(What|Why|Door): (.+)$/.exec(line);
  if (single) {
    const key = single[1] === "What" ? "what" : single[1] === "Why" ? "why" : "door";
    if (draft[key] !== undefined) return false;
    draft[key] = single[2]!;
    list.current = null;
    return true;
  }
  if (line === "Pros:" || line === "Cons:") return (list.current = line === "Pros:" ? draft.pros : draft.cons), true;
  const bullet = /^- (.+)$/.exec(line);
  if (!bullet || list.current === null) return false;
  list.current.push(bullet[1]!);
  return true;
}

/**
 * The one OWNER-BRIEF block after the verdict line, or null when there is none or it is malformed, too long or has
 * a door type other than two-way or one-way. Only the parsed fields are returned, never the surrounding text.
 */
export function parseOwnerBrief(text: string): OwnerBrief | null {
  const lines = text.split("\n").map((line) => line.trim());
  const verdictAt = lines.findIndex((line) => line.startsWith("Verdict:"));
  const starts = lines.flatMap((line, index) => (index > verdictAt && verdictAt >= 0 && line === OWNER_BRIEF_START ? [index] : []));
  if (starts.length !== 1) return null;
  const end = lines.indexOf(OWNER_BRIEF_END, starts[0]);
  const body = lines.slice(starts[0]! + 1, end < 0 ? undefined : end);
  if (body.join("\n").length > MAX_OWNER_BRIEF_CHARS) return null;
  const draft: Draft = { pros: [], cons: [] };
  const list = { current: null as string[] | null };
  if (!body.every((line) => takeLine(draft, line, list))) return null;
  const parsed = OwnerBriefSchema.safeParse({ what: draft.what, why: draft.why, pros: draft.pros, cons: draft.cons, doorType: draft.door });
  return parsed.success ? parsed.data : null;
}

/** Keyed by the closed union, so a refusal the parser adds fails to compile here until it is listed. */
export const MALFORMED_REFUSALS: Record<MalformedRefusal, true> = {
  no_block: true,
  multiple_blocks: true,
  bad_verdict: true,
  missing_pr_line: true,
  bad_pr: true,
  missing_head_line: true,
  bad_head: true,
  wrong_target: true,
};

const Refusal = z.string().refine((value): value is MalformedRefusal => Object.hasOwn(MALFORMED_REFUSALS, value), "a malformed refusal");
export const MalformedSchema = z.object({ refusal: Refusal, writtenAt: z.number().refine(Number.isFinite, "epoch milliseconds") });

/** The record `acceptVerdict` leaves on a `none` whose final message was malformed; `writtenAt` is that message's time. */
export type Malformed = z.infer<typeof MalformedSchema>;

const WithMalformed = z.looseObject({ kind: z.literal("none"), malformed: MalformedSchema });

/** The `malformed` record in a stored await output, or null for any output without a valid one. */
export function readMalformed(output: unknown): Malformed | null {
  const parsed = WithMalformed.safeParse(output);
  return parsed.success ? parsed.data.malformed : null;
}

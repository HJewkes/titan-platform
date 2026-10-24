import { z } from "zod";
import type { AuditionSlot } from "./audition-pool.js";
import type { MaterialFact } from "./material-facts.js";
import type { MaterialMap } from "./material-map.js";
import type { TypeProfile } from "./profile-schema.js";
import type { NarrativeStructure } from "./structure-schema.js";

/** One block of a sampled spine: the question it opens, the facts that answer it, its length and its lead beat. */
const SpineBlockSchema = z.strictObject({
  id: z.string().min(1),
  question: z.string().min(1),
  facts: z.array(z.string().min(1)).min(1),
  seconds: z.number().int().positive(),
  beat: z.string().min(1),
  covers: z.array(z.string()).default([]),
});

/** What each spine carries (plan §A.3 step 3), plus the likelihood the sampling call states for it. */
export const SpineCandidateSchema = z.strictObject({
  structure: z.string().min(1),
  system: z.string().nullable(),
  likelihood: z.number().gt(0).max(1),
  sentence: z.string().min(1),
  hook: z.strictObject({ fact: z.string().min(1), line: z.string().min(1) }),
  blocks: z.array(SpineBlockSchema).min(2),
  payoff: z.string().min(1),
  signatureLayer: z.string().min(1),
  cuts: z.array(z.string()).default([]),
});
export type SpineCandidate = z.infer<typeof SpineCandidateSchema>;

const ReplySchema = z.strictObject({ spines: z.array(SpineCandidateSchema) });

/** A block the slot's spine must fill, in order: the profile's block for that macro, else the structure's own. */
export interface SlotBlock {
  id: string;
  goal: string;
  /** The beats the profile lists for the block; empty when the block comes from the structure and any beat will do. */
  beats: string[];
}

export function slotBlocks(profile: TypeProfile, structure: NarrativeStructure): SlotBlock[] {
  const own = new Map(profile.structure.blocks.map((block) => [block.id, block]));
  const fromProfile = (ids: readonly string[]) => ids.flatMap((id) => (own.has(id) ? [{ id, goal: own.get(id)!.goal, beats: [...own.get(id)!.beats] }] : []));
  if (profile.structure.order === "fixed" && profile.structure.macro === structure.id) return fromProfile(profile.structure.blocks.map((b) => b.id));
  const ids = profile.structure.order === "heuristic" ? profile.structure.macros[structure.id] : undefined;
  return ids ? fromProfile(ids) : structure.blocks.map((block) => ({ id: block.id, goal: block.goal, beats: [] }));
}

export interface SampleContext {
  slots: readonly AuditionSlot[];
  blocks: ReadonlyMap<string, SlotBlock[]>;
  structures: ReadonlyMap<string, NarrativeStructure>;
  profile: TypeProfile;
  map: MaterialMap;
  facts: readonly MaterialFact[];
}

function slotText(ctx: SampleContext, slot: AuditionSlot, i: number): string {
  const structure = ctx.structures.get(slot.structure)!;
  const blocks = ctx.blocks.get(slot.structure)!.map((b) => `   - ${b.id}: ${b.goal}${b.beats.length ? ` (beats: ${b.beats.join(", ")})` : ""}`);
  const why = slot.basis === "undecided" ? " Its fit turns on a signal the map cannot judge; say in the likelihood how well the facts carry it." : "";
  return [`${i + 1}. structure ${slot.structure}, system ${slot.system ?? "none"} (${slot.basis}): ${structure.summary}${why}`, `   hook rule: ${structure.hook}`, ...blocks].join("\n");
}

const SAMPLE_TASK = `## Task

Write one story spine per slot above, in slot order, each a different take on the same facts. Stop at the storyboard: no script, no beats past the lead beat of each block.
For each spine state its likelihood: your probability, between 0 and 1, that it is the best video for this profile. Do not make the slots agree; sample from the whole distribution of good spines.
- "structure" and "system" repeat the slot's own.
- "blocks" lists every block of the slot, in order, with its id; "beat" is one of the block's listed beats.
- "facts" and "hook.fact" cite only fact ids from the facts list; "covers" names only the profile's coverage items.
- "payoff" is the id of the block where the first payoff lands. "sentence" is the ABT or SCQA sentence.
Reply with one JSON object {"spines": [...]} only.`;

export function samplePrompt(ctx: SampleContext): string {
  const { profile, map } = ctx;
  const holding = map.signals.filter((row) => row.holds === true).map((row) => `${row.id} (${row.facts.join(", ")})`);
  const facts = ctx.facts.map((fact) => `- ${fact.id}${fact.priority ? ` [${fact.priority}]` : ""}: ${fact.text}`);
  return [
    `# Audition: ${ctx.slots.length} spines for one ${profile.type} video (about ${profile.runtime.targetS} s)`,
    `## Profile\n\nIntent: ${profile.intent}\nHook: ${profile.hook}\nCoverage items: ${profile.coverage.join(", ")}`,
    `## Material\n\nSignals holding: ${holding.join("; ") || "none"}\nUnjudged signals: ${map.gaps.join(", ") || "none"}`,
    `## Facts\n\n${facts.join("\n")}`,
    `## Slots\n\n${ctx.slots.map((slot, i) => slotText(ctx, slot, i)).join("\n\n")}`,
    `## Reply shape\n\n\`\`\`json\n${JSON.stringify(z.toJSONSchema(ReplySchema, { io: "input" }))}\n\`\`\``,
    SAMPLE_TASK,
  ].join("\n\n") + "\n";
}

function spineIssues(ctx: SampleContext, spine: SpineCandidate, slot: AuditionSlot, at: string): string[] {
  const known = new Set(ctx.facts.map((fact) => fact.id));
  const coverage = new Set(ctx.profile.coverage);
  const blocks = ctx.blocks.get(slot.structure)!;
  const issues: string[] = [];
  if (spine.structure !== slot.structure || spine.system !== slot.system) issues.push(`${at}: slot is ${slot.structure}/${slot.system ?? "null"}, got ${spine.structure}/${spine.system ?? "null"}`);
  const ids = spine.blocks.map((b) => b.id).join(",");
  if (ids !== blocks.map((b) => b.id).join(",")) issues.push(`${at}.blocks: need ${blocks.map((b) => b.id).join(", ")} in order, got ${ids}`);
  for (const block of spine.blocks) {
    const allowed = blocks.find((b) => b.id === block.id)?.beats ?? [];
    if (allowed.length > 0 && !allowed.includes(block.beat)) issues.push(`${at}.${block.id}.beat: ${block.beat} is not one of ${allowed.join(", ")}`);
    const outside = block.covers.filter((c) => !coverage.has(c));
    if (outside.length) issues.push(`${at}.${block.id}.covers: ${outside.join(", ")} not coverage items`);
  }
  const unknown = [spine.hook.fact, ...spine.blocks.flatMap((b) => b.facts)].filter((id) => !known.has(id));
  if (unknown.length) issues.push(`${at}: unknown fact ids ${[...new Set(unknown)].join(", ")}`);
  if (!spine.blocks.some((b) => b.id === spine.payoff)) issues.push(`${at}.payoff: ${spine.payoff} is not a block id`);
  return issues;
}

/** The reply's spines, or every issue that keeps it from standing as the audition's k candidates. */
export function checkSample(ctx: SampleContext, text: string): { spines?: SpineCandidate[]; issues: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return { issues: ["the reply holds no JSON object"] };
  }
  const parsed = ReplySchema.safeParse(raw);
  if (!parsed.success) return { issues: parsed.error.issues.slice(0, 25).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  const { spines } = parsed.data;
  if (spines.length !== ctx.slots.length) return { issues: [`need ${ctx.slots.length} spines, one per slot, got ${spines.length}`] };
  const issues = spines.flatMap((spine, i) => spineIssues(ctx, spine, ctx.slots[i]!, `spines.${i}`));
  return issues.length ? { issues } : { spines, issues };
}

export const sampleRetryPrompt = (prompt: string, issues: readonly string[]): string =>
  `${prompt}\n## Your previous reply was rejected\n\n${issues.map((i) => `- ${i}`).join("\n")}\n\nReply with the whole corrected object.\n`;

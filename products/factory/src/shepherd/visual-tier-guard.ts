// TP-4761 S2: the visual tier recorded at the evidence step, and what its mode does to the visual-path row. Tier 1 is
// built only in visual-tier.ts; this module records it, reads it back through a schema and applies the mode.
import type { MergeFacts } from "@titan-design/authority";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import { oneLine } from "../gate-brief.js";
import type { VisualThreshold } from "./visual-threshold.js";
import { shownPaths, visualMatches } from "./visual-gate.js";
import { visualTier } from "./visual-tier.js";

/** The per-repo visual config the evidence step reads afresh at each head. */
export interface VisualReadsWiring {
  /** `shepherd.visualThreshold` for a repo; absent, or undefined for a repo, measures nothing. */
  visualThreshold?: (repo: string) => VisualThreshold | undefined;
  /** Raw `shepherd.visualTier` for a repo, parsed only by visual-tier.ts; absent, or undefined for a repo, records no tier. */
  visualTier?: (repo: string) => unknown;
}

const MAX_REASON = 500;

const VisualTierRecordSchema = z.strictObject({
  mode: z.enum(["shadow", "on"]),
  /** The changed paths the evidence step's globs matched as visual; decide-time globs may be wider (TP-4761 S2 review). */
  judged: z.array(z.string()),
  verdict: z.union([
    z.strictObject({ tier: z.literal(1), basis: z.literal("non-rendering") }),
    z.strictObject({ tier: z.literal(2), reason: z.string() }),
  ]),
});

export type VisualTierRecord = z.infer<typeof VisualTierRecordSchema>;

/** Only an entry reading exactly `off`, or none, is off; any other entry records, and only an exact `on` decides. */
function tierMode(config: unknown): VisualTierRecord["mode"] | undefined {
  if (config === undefined) return undefined;
  const mode: unknown = typeof config === "object" && config !== null ? (config as { mode?: unknown }).mode : undefined;
  if (mode === "off") return undefined;
  return mode === "on" ? "on" : "shadow";
}

/** A failed read is "", which the tier's input schema refuses, so the head reads tier 2. */
async function mergeBaseOf(port: Pick<GitHubPort, "compareFiles">, repo: RepoSlug, baseRef: string, head: string): Promise<string> {
  try {
    return (await port.compareFiles(repo, baseRef, head)).mergeBaseSha;
  } catch {
    return "";
  }
}

interface TierTarget {
  repo: RepoSlug;
  baseRef: string;
  visualPaths: readonly string[] | undefined;
  config: unknown;
}

/** The tier of a head the visual-path row would gate, judged on every changed path; pixels never lower it (TP-4761 C2). */
export async function readVisualTier(port: Pick<GitHubPort, "compareFiles">, merge: MergeFacts, target: TierTarget): Promise<{ visualTier: VisualTierRecord } | undefined> {
  const { repo, baseRef, visualPaths, config } = target;
  const mode = tierMode(config);
  const judged = visualPaths === undefined ? [] : visualMatches(merge.changedPaths, visualPaths);
  if (mode === undefined || visualPaths === undefined || judged.length === 0) return undefined;
  const mergeBase = await mergeBaseOf(port, repo, baseRef, merge.head);
  return { visualTier: { mode, judged, verdict: visualTier({ merge, visualPaths, mergeBase, config }) } };
}

/** A stored record is read back unvalidated, so one that fails the schema is tier 2 whatever mode it claims. */
function readRecord(recorded: unknown): VisualTierRecord | undefined {
  if (recorded === undefined) return undefined;
  const parsed = VisualTierRecordSchema.safeParse(recorded);
  return parsed.success ? parsed.data : { mode: "on", judged: [], verdict: { tier: 2, reason: "the recorded visual tier is malformed" } };
}

/**
 * Under `on`, tier 1 clears the visual-path row and tier 2 keeps it with its why; shadow or no record leaves it as it
 * was. The decide step's globs can be wider than the ones the tier judged under, so a decide-time visual path the tier
 * never judged as visual reads as tier 2.
 */
export function tierOutcome(recorded: unknown, visual: readonly string[]): { clears: true; note: string } | { clears: false; note: string } | undefined {
  const record = readRecord(recorded);
  if (record?.mode !== "on") return undefined;
  const { verdict, judged } = record;
  if (verdict.tier === 2) return { clears: false, note: `; tier 2: ${oneLine(verdict.reason, MAX_REASON)}` };
  const unjudged = visual.filter((path) => !judged.includes(path));
  if (unjudged.length > 0) return { clears: false, note: `; tier 2: the tier did not judge ${shownPaths(unjudged)} as visual` };
  return { clears: true, note: `tier 1 (${verdict.basis})` };
}

/** The allow note for visual files a tier 1 under `on` cleared, so the evidence comment records why the row did not fire. */
export function tierClearance(recorded: unknown, changedPaths: readonly string[], visualPaths: readonly string[] | undefined): string {
  const visual = visualPaths === undefined ? [] : visualMatches(changedPaths, visualPaths);
  const outcome = tierOutcome(recorded, visual);
  return outcome?.clears && visual.length > 0 ? `; visual files ${shownPaths(visual)} ${outcome.note}` : "";
}

/** The evidence comment's tier line: shadow says what `on` would do, and a malformed record says it reads as tier 2. */
export function tierLine(recorded: unknown): string[] {
  const record = readRecord(recorded);
  if (record === undefined) return [];
  const { mode, verdict } = record;
  const said = verdict.tier === 1 ? `tier 1 (${verdict.basis})` : `tier 2: ${oneLine(verdict.reason, MAX_REASON)}`;
  const effect = mode === "on" ? (verdict.tier === 1 ? "the visual-path row is cleared" : "the visual-path row gates") : "recorded only; the decision is unchanged";
  return ["", `**Visual tier** (${mode}): ${said}; ${effect}.`];
}

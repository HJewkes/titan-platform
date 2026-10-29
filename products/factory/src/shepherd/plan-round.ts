// The drafting half of the plan round (TP-4360): one PR's planned file list becomes a questions-only round.json whose
// planApprovals bind each predicted WHAT gate. It writes nothing; the owner's pick, filed through the console, is the
// only path to a plan-approval row.
import { createHash } from "node:crypto";
import { isRepo } from "@titan-design/github";
import { buildPlanRound, type PlanAsk, type PlanRound } from "@titan-design/owner-queue";
import { CI_POLICY_KEYS } from "@titan-design/session-read";
import { z } from "zod";
import { PlanApprovalActionSchema } from "../console-action/record.js";
import { ciPolicyChanges, shownLine, type CiPolicyFileChange } from "./ci-policy-changes.js";
import { isGithubPath } from "./ci-policy-read.js";
import type { CiPolicyScope } from "./plan-approval.js";
import { skillPathsIn } from "./skill-paths.js";
import { visualMatches } from "./visual-gate.js";

/** The plan block names something the guard could not honour; nothing is printed, so nothing reaches the owner half-bound. */
export class PlanRoundRefused extends Error {
  override readonly name = "PlanRoundRefused";
}

/** The pinned scope's own cap, as `CiPolicyScopeSchema` and the head-blob read hold it. */
const MAX_PINNED_FILES = 20;
const AUTHORITY_TABLE = "packages/authority/src/table.json";
export const NOTHING_PREDICTED = "no WHAT gate predicted; file no round";

const PlannedFileSchema = z
  .strictObject({ path: z.string().min(1).max(512), content: z.string().optional(), absent: z.literal(true).optional() })
  .refine((file) => file.content === undefined || file.absent === undefined, "a file has content or is absent, not both");

export const PlanBlockSchema = z.strictObject({
  task: z.string().min(1).max(256),
  repo: z.string().refine(isRepo, "must be a bare owner/name"),
  summary: z.string().min(1).max(200),
  files: z
    .array(PlannedFileSchema)
    .min(1)
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length, "each planned path appears once"),
  ciPolicyKeys: z.array(z.enum(CI_POLICY_KEYS)).optional(),
  /** Binds a ci-policy question with no `.github/` path planned, for a weakening in package.json scripts or the like. */
  ciPolicy: z.literal(true).optional(),
  why: z.record(z.string(), z.string()).optional(),
});
export type PlanBlock = z.infer<typeof PlanBlockSchema>;

const FENCE = /^```plan-round[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/** A JSON object as is, or a markdown plan holding exactly one `plan-round` fence, since a second would leave the PR ambiguous. */
export function readPlanBlock(text: string): PlanBlock {
  const fences = text.trimStart().startsWith("{") ? [text] : [...text.matchAll(FENCE)].map((match) => match[1]!);
  if (fences.length !== 1) throw new PlanRoundRefused(`the plan holds ${fences.length} \`\`\`plan-round fences; give exactly one, for one PR`);
  let json: unknown;
  try {
    json = JSON.parse(fences[0]!);
  } catch (error) {
    throw new PlanRoundRefused(`the plan-round block is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = PlanBlockSchema.safeParse(json);
  if (!parsed.success) throw new PlanRoundRefused(`the plan-round block is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** `git hash-object` of the committed bytes, which is GitHub's blob sha for the file the guard reads at head. */
export function blobOf(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** Blob shas read at `--pin-from`, by planned path; null where the ref holds no such path. */
export type RefPins = ReadonlyMap<string, string | null>;

export function pinFiles(plan: PlanBlock, pins?: RefPins): CiPolicyScope["files"] {
  if (pins) return plan.files.map((file) => ({ path: file.path, blob: pins.get(file.path) ?? null }));
  return plan.files.map((file) => ({ path: file.path, blob: file.content === undefined ? null : blobOf(Buffer.from(file.content, "utf8")) }));
}

/** The re-ask pins the bytes a drifted head really holds, so a path that also states its bytes inline would leave two answers. */
export async function pinsAt(plan: PlanBlock, git: GitRead, ref: string): Promise<RefPins> {
  const inline = plan.files.filter((file) => file.content !== undefined || file.absent !== undefined).map((file) => file.path);
  if (inline.length > 0) throw new PlanRoundRefused(`--pin-from ${ref} pins every planned file from that ref, and ${inline.join(", ")} also gives content or absent inline; drop those fields from the block`);
  return new Map(await Promise.all(plan.files.map(async (file) => [file.path, await git.blob(ref, file.path)] as const)));
}

interface GatePrediction {
  ciPolicy?: CiPolicyScope;
  skill?: string[];
  visual?: string[];
  notes: string[];
}

/** One prediction per WHAT gate, each from the guard's own predicate, so the round asks exactly what merge would. */
export function predictGates(plan: PlanBlock, visualPaths: readonly string[] | undefined, pins?: RefPins): GatePrediction {
  const paths = plan.files.map((file) => file.path);
  const ciPolicy = predictCiPolicy(plan, pins);
  const skill = skillPathsIn(paths);
  const visual = visualPaths === undefined ? [] : visualMatches(paths, visualPaths);
  const notes = paths.some((path) => path.toLowerCase() === AUTHORITY_TABLE)
    ? [`no plan approval covers the authority table yet (TP-3201 / audit F6); ${AUTHORITY_TABLE} is held for adversary review and its owner sign-off stays at merge`]
    : [];
  return { ...(ciPolicy && { ciPolicy }), ...(skill.length > 0 && { skill }), ...(visual.length > 0 && { visual }), notes };
}

/** `ciPolicyCovers` needs every changed path pinned, so a policy question binds only a plan that gives every file's bytes. */
function predictCiPolicy(plan: PlanBlock, pins: RefPins | undefined): CiPolicyScope | undefined {
  const github = plan.files.map((file) => file.path).filter(isGithubPath);
  if (github.length === 0 && plan.ciPolicy === undefined) return undefined;
  const keys = plan.ciPolicyKeys;
  if (keys === undefined) {
    const why = github.length > 0 ? `plans .github/ paths (${github.join(", ")})` : "sets ciPolicy";
    throw new PlanRoundRefused(`the plan ${why} but names no ciPolicyKeys; list the keys it weakens from ${CI_POLICY_KEYS.join(", ")}, or [] when it weakens none`);
  }
  if (keys.length === 0) {
    if (plan.ciPolicy) throw new PlanRoundRefused("ciPolicy: true needs at least one ciPolicyKeys entry");
    return undefined;
  }
  const unpinned = pins ? [] : plan.files.filter((file) => file.content === undefined && file.absent === undefined).map((file) => file.path);
  const unpinnedRefusal = `a CI-policy approval pins every file its PR changes, and ${unpinned.join(", ")} has no content or absent; split the policy edit into its own PR`;
  if (unpinned.length > 0) throw new PlanRoundRefused(unpinnedRefusal);
  if (plan.files.length > MAX_PINNED_FILES) throw new PlanRoundRefused(`a CI-policy approval pins at most ${MAX_PINNED_FILES} files, and the plan lists ${plan.files.length}`);
  return { ciPolicyKeys: keys, files: pinFiles(plan, pins) };
}

/** Reads in the planner's checkout. `show` and `blob` give null when the ref holds no such path; a ref that is no commit throws. */
export interface GitRead {
  show(ref: string, path: string): Promise<string | null>;
  blob(ref: string, path: string): Promise<string | null>;
  commit(ref: string): Promise<string>;
  /** Every path `git diff -M <base>...<ref>` changes, both sides of a rename included. */
  diffNames(base: string, ref: string): Promise<string[]>;
}

/** Each pinned file against the base, rendered by the D21 card's own differ, so the owner reads at plan time what merge would show. */
async function ownerDiff(plan: PlanBlock, git: GitRead, base: string, pinFrom: string | undefined): Promise<CiPolicyFileChange[]> {
  const after = async (file: PlanBlock["files"][number]) => (pinFrom === undefined ? (file.content ?? "") : ((await git.show(pinFrom, file.path)) ?? ""));
  const files = await Promise.all(plan.files.map(async (file) => ({ path: file.path, before: (await git.show(base, file.path)) ?? "", after: await after(file) })));
  return ciPolicyChanges(files);
}

function diffLines(changes: readonly CiPolicyFileChange[]): string[] {
  return changes.flatMap((change) => [
    `${change.path}:`,
    ...change.lines.map(({ side, n, text }) => `${side} L${n}: ${text}`),
    ...(change.omitted > 0 ? [`${change.omitted} more changed lines in ${change.path}`] : []),
  ]);
}

const whyLines = (plan: PlanBlock, paths: readonly string[]): string[] => paths.flatMap((path) => (plan.why?.[path] ? [`Why ${shownLine(path)}: ${shownLine(plan.why[path])}`] : []));

const pathAsk = (plan: PlanBlock, gate: "skill" | "visual", paths: string[]): PlanAsk => ({
  gate,
  scope: { paths },
  title: `${plan.summary} (${gate} paths)`,
  context: [`Paths: ${paths.map(shownLine).join(", ")}.`, ...whyLines(plan, paths)].join("\n"),
});

async function asksOf(plan: PlanBlock, predicted: GatePrediction, git: GitRead, options: PlanRoundOptions): Promise<PlanAsk[]> {
  const asks: PlanAsk[] = [];
  if (predicted.ciPolicy) {
    const diff = await ownerDiff(plan, git, options.base, options.pinFrom);
    const lines = [`Weakens: ${predicted.ciPolicy.ciPolicyKeys.join(", ")}.`, ...diffLines(diff), ...whyLines(plan, plan.files.map((file) => file.path))];
    asks.push({ gate: "ci-policy", scope: predicted.ciPolicy, title: `${plan.summary} (CI policy)`, context: lines.join("\n") });
  }
  if (predicted.skill) asks.push(pathAsk(plan, "skill", predicted.skill));
  if (predicted.visual) asks.push(pathAsk(plan, "visual", predicted.visual));
  return asks;
}

interface PlanRoundOptions {
  round: number;
  base: string;
  supersedes?: string[];
  storybookUrl?: string;
  /** The re-ask: pin each planned file to the blob this ref holds, rather than to inline content. */
  pinFrom?: string;
  /** The `visual_paths` of the seat that owns the plan's repo; undefined when no seat opts in. */
  visualPaths?: readonly string[];
}

/** `round` is absent when no gate is predicted; `notes` go to stderr and are never bound. */
interface PlanRoundResult {
  round?: PlanRound;
  notes: string[];
}

export const planUnit = (task: string): string => `plan-${task.toLowerCase().replace(/\//g, "-")}`;

/** Every binding is checked with the factory's own record schema, so a round that would record nothing is refused here, not at the owner's pick. */
function checkBindings(round: PlanRound): void {
  for (const { task, repo, gate, scope } of round.planApprovals) {
    const parsed = PlanApprovalActionSchema.safeParse({ kind: "plan-approval", task, repo, round: "x", gate, scope });
    if (!parsed.success) throw new PlanRoundRefused(`the ${gate} binding would not record: ${z.prettifyError(parsed.error)}`);
  }
}

export async function planRound(plan: PlanBlock, options: PlanRoundOptions, git: GitRead): Promise<PlanRoundResult> {
  const pins = options.pinFrom === undefined ? undefined : await pinsAt(plan, git, options.pinFrom);
  const predicted = predictGates(plan, options.visualPaths, pins);
  const asks = await asksOf(plan, predicted, git, options);
  if (asks.length === 0) return { notes: [...predicted.notes, NOTHING_PREDICTED] };
  const { round, supersedes, storybookUrl } = options;
  const built = buildPlanRound({ unit: planUnit(plan.task), round, task: plan.task, repo: plan.repo, asks, ...(supersedes && { supersedes }), ...(storybookUrl && { storybookUrl }) });
  checkBindings(built);
  return { round: built, notes: predicted.notes };
}

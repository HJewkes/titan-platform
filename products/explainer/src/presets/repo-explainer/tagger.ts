import { createHash } from "node:crypto";
import { pickControls, placeControls, type Planted } from "@titan-design/evidence";
import { mapItems, StepFailedError, type StepResult, type StepUsage, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { EvidenceSpan, ExplainerFact } from "./schemas.js";

/** Workflow plan §1.2 S2 roles, plus the tour roles decision 326 §7.1 adds. */
export const TAG_ROLES = [
  "value", "ux", "architecture", "mechanism", "idea", "issue",
  "purpose", "entry", "feature", "algorithm", "health", "adopt", "avoid",
] as const;
export type TagRole = (typeof TAG_ROLES)[number];

/** S2 runs haiku in the lean tier and sonnet in the default tier; the value is the model passed to dispatch. */
export const TAGGER_ARMS = { haiku: "haiku", sonnet: "sonnet" } as const;
export type TaggerArm = keyof typeof TAGGER_ARMS;

const IDEA_LINE_WORDS = 20;
const Score = z.number().int().min(0).max(3);

export const FactTagSchema = z.object({
  id: z.string().min(1),
  role: z.array(z.enum(TAG_ROLES)).min(1),
  novelty: Score,
  visual: Score,
  visual_kind: z.string().min(1),
  idea_line: z.string().min(1).refine((line) => line.trim().split(/\s+/).length <= IDEA_LINE_WORDS, `at most ${IDEA_LINE_WORDS} words`),
});
export type FactTag = z.infer<typeof FactTagSchema>;

const TagReplySchema = z.object({ tags: z.array(FactTagSchema) });

/** A fact whose role is known, planted once per batch to check the arm is reading the facts. */
export interface TagControl {
  fact: ExplainerFact;
  expect: TagRole;
}

export interface TagFactsOptions {
  arm: TaggerArm;
  /** The pool each batch draws its one planted control from; it must not be empty. */
  controls: readonly TagControl[];
  onePager: string;
  /** Who watches, from the type profile's audience pack (`viewer`). */
  viewer: string;
  /** Up to three lines of the cited code for a span; absent, the prompt carries the fact text only. */
  excerpt?: (span: EvidenceSpan) => string | undefined;
  batchSize?: number;
  concurrency?: number;
  budgetUsd?: number;
}

export interface TagBatch {
  key: string;
  facts: ExplainerFact[];
  control: TagControl;
  sequence: Planted<ExplainerFact, TagControl>[];
}

export interface DroppedBatch {
  key: string;
  factIds: string[];
  error: string;
}

export interface TagFactsResult {
  tags: FactTag[];
  /** Batches that failed their control twice, or whose call failed; their facts carry no tags. */
  dropped: DroppedBatch[];
  /** Batches never launched because the budget ran out or a failure stopped the run. */
  skipped: string[];
  spentUsd: number;
  stoppedBy: "budget" | "failure" | "cost_unknown" | null;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 4;
const RETRY_SUFFIX = ":retry";

function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let at = 0; at < items.length; at += size) groups.push(items.slice(at, at + size));
  return groups;
}

// The prompt inputs join the key, so an edited one-pager or viewer re-tags instead of replaying a stale answer.
function batchKey(facts: readonly ExplainerFact[], options: TagFactsOptions): string {
  const hash = createHash("sha256").update(options.onePager).update("\0").update(options.viewer);
  for (const fact of facts) hash.update(`\0${fact.id}\0${fact.text}\0${JSON.stringify(fact.evidence)}`);
  return hash.digest("hex").slice(0, 16);
}

/** Splits facts into batches, each with one seeded control drawn from the pool and placed at a seeded position. */
export function buildTagBatches(facts: readonly ExplainerFact[], options: TagFactsOptions): TagBatch[] {
  if (options.controls.length === 0) throw new Error("tagger: the control pool is empty, so no batch can be checked");
  return chunk(facts, options.batchSize ?? DEFAULT_BATCH_SIZE).map((group) => {
    const key = batchKey(group, options);
    const ids = new Set(group.map((fact) => fact.id));
    const pool = options.controls.filter((control) => !ids.has(control.fact.id));
    const [control] = pickControls(pool, key, 1);
    if (!control) throw new Error(`tagger: every control shares an id with batch ${key}`);
    return { key, facts: group, control, sequence: placeControls(group, [control], key).sequence };
  });
}

function showFact(fact: ExplainerFact, excerpt: TagFactsOptions["excerpt"]): string {
  const spans = fact.evidence.flatMap((span) => {
    const lines = excerpt?.(span);
    return lines === undefined ? [] : [`\`\`\`\n${lines}\n\`\`\``];
  });
  return [`### ${fact.id}`, fact.text, ...spans].join("\n");
}

/** The batch's one-turn prompt; the control is shown like any other fact. */
export function tagPrompt(batch: TagBatch, options: TagFactsOptions): string {
  const facts = batch.sequence.map((entry) => showFact(entry.kind === "item" ? entry.value : entry.value.fact, options.excerpt));
  return [
    "## Task",
    `Tag every fact below for an explainer video. The viewer: ${options.viewer}.`,
    `Reply with one JSON object {"tags": [...]}, one entry per fact id, each with role (one or more of ${TAG_ROLES.join(", ")}),`,
    `novelty 0-3, visual 0-3, visual_kind (a beat type) and idea_line (at most ${IDEA_LINE_WORDS} words).`,
    "## Repo one-pager",
    options.onePager,
    "## Facts",
    ...facts,
  ].join("\n\n") + "\n";
}

/** Why the reply fails the batch's control, or null when the control carries its expected role. */
export function controlFailure(batch: TagBatch, tags: readonly FactTag[]): string | null {
  const { fact, expect } = batch.control;
  const answer = tags.find((tag) => tag.id === fact.id);
  if (!answer) return `control ${fact.id} was not tagged`;
  return answer.role.includes(expect) ? null : `control ${fact.id} expected role ${expect}, got ${answer.role.join(", ")}`;
}

function sumUsage(a: StepUsage | undefined, b: StepUsage | undefined): StepUsage | undefined {
  if (!a || !b) return a ?? b;
  const unknown = a.costUnknown || b.costUnknown;
  return { costUsd: a.costUsd + b.costUsd, ...(unknown ? { costUnknown: true as const } : {}) };
}

interface Attempt {
  result: StepResult<z.infer<typeof TagReplySchema>>;
  failure: string | null;
}

async function attempt(ctx: WorkflowContext, stepId: string, batch: TagBatch, options: TagFactsOptions): Promise<Attempt> {
  const result = await ctx.dispatch(stepId, tagPrompt(batch, options), { model: TAGGER_ARMS[options.arm], schema: TagReplySchema });
  return { result, failure: controlFailure(batch, result.data?.tags ?? []) };
}

/** One batch: a failed control re-runs it once under its own step id, and a second failure drops it. */
async function tagBatch(ctx: WorkflowContext, stepId: string, batch: TagBatch, options: TagFactsOptions): Promise<StepResult> {
  const first = await attempt(ctx, stepId, batch, options);
  const final = first.failure === null ? first : await attempt(ctx, `${stepId}${RETRY_SUFFIX}`, batch, options);
  const usage = final === first ? first.result.usage : sumUsage(first.result.usage, final.result.usage);
  if (final.failure !== null) {
    throw new StepFailedError(stepId, final.result.iteration, `${final.failure} on both attempts`, { retryable: true, ...(usage ? { usage } : {}) });
  }
  const ids = new Set(batch.facts.map((fact) => fact.id));
  const tags = (final.result.data?.tags ?? []).filter((tag) => ids.has(tag.id));
  return { ...final.result, data: { tags }, ...(usage ? { usage } : {}) };
}

/**
 * S2 tag (workflow plan §1.2): one memoized `mapItems` item per batch, under step `tag:<arm>`, so a replay reuses
 * every batch whose facts and prompt inputs are unchanged. A dropped batch never stops the others.
 */
export async function tagFacts(ctx: WorkflowContext, facts: readonly ExplainerFact[], options: TagFactsOptions): Promise<TagFactsResult> {
  const batches = buildTagBatches(facts, options);
  const mapped = await mapItems(ctx, `tag:${options.arm}`, batches, (batch, stepId) => tagBatch(ctx, stepId, batch, options), {
    key: (batch) => batch.key,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    maxFailures: batches.length,
    ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }),
  });
  return {
    tags: mapped.results.flatMap(({ result }) => TagReplySchema.parse(result.data).tags),
    dropped: mapped.failed.map(({ key, item, error }) => ({ key, factIds: item.facts.map((fact) => fact.id), error })),
    skipped: mapped.skipped.map(({ key }) => key),
    spentUsd: mapped.spentUsd,
    stoppedBy: mapped.stoppedBy,
  };
}

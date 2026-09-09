import { applyMaturity, scorePlaybook, type MaturityChange } from "./playbook.js";
import type { BlockedPattern, PlaybookStore } from "./store.js";
import { contentKey, isNegated, jaccard, normalizeContent } from "./text.js";
import { PlaybookDeltaSchema, type AddDelta, type Bullet, type ParsedDelta, type PlaybookDelta, type Provenance, type ScoredBullet } from "./types.js";

export interface InversionOptions {
  /** Decayed harmful mass a rule needs before it can flip into an anti-pattern. */
  minHarmful?: number;
  /** And by how much harmful must outweigh helpful. */
  harmfulToHelpfulRatio?: number;
}

export interface CurateOptions {
  /** Stamped onto every bullet this batch creates. Never taken from the deltas themselves. */
  provenance?: Provenance;
  now?: () => Date;
  /** Jaccard similarity at which an `add` folds into a `helpful` on the existing bullet. */
  nearDupThreshold?: number;
  /** Jaccard similarity at which two rules are flagged as possibly contradicting. */
  conflictThreshold?: number;
  inversion?: InversionOptions;
}

export interface Conflict {
  bulletId: string;
  otherId: string;
  reason: string;
}

export interface CurationReport {
  added: string[];
  reinforced: string[];
  penalized: string[];
  deprecated: string[];
  inverted: { from: string; to: string }[];
  blocked: string[];
  skipped: { delta: ParsedDelta; reason: string }[];
  conflicts: Conflict[];
  maturityChanges: MaturityChange[];
}

interface Ctx {
  store: PlaybookStore;
  report: CurationReport;
  now: () => Date;
  provenance: Provenance[];
  nearDup: number;
  conflict: number;
  inversion: Required<InversionOptions>;
  blocked: BlockedPattern[];
}

/**
 * cass-memory's curator: zero LLM, fully deterministic. Dedup by content hash
 * and near-dup Jaccard, apply the batch, invert rules that keep hurting into
 * `AVOID:` anti-patterns, then run the maturity pass.
 */
export function curate(store: PlaybookStore, deltas: readonly PlaybookDelta[], options: CurateOptions = {}): CurationReport {
  const ctx = makeContext(store, options);
  const parsed = deltas.map((delta) => PlaybookDeltaSchema.parse(delta));
  for (const delta of dedupeDeltas(parsed, ctx.report)) applyDelta(ctx, delta);
  invertHarmfulRules(ctx);
  ctx.report.maturityChanges = applyMaturity(store, ctx.now());
  return ctx.report;
}

function makeContext(store: PlaybookStore, options: CurateOptions): Ctx {
  return {
    store,
    report: { added: [], reinforced: [], penalized: [], deprecated: [], inverted: [], blocked: [], skipped: [], conflicts: [], maturityChanges: [] },
    now: options.now ?? (() => new Date()),
    provenance: options.provenance ? [options.provenance] : [],
    nearDup: options.nearDupThreshold ?? 0.85,
    conflict: options.conflictThreshold ?? 0.5,
    inversion: { minHarmful: options.inversion?.minHarmful ?? 3, harmfulToHelpfulRatio: options.inversion?.harmfulToHelpfulRatio ?? 2 },
    blocked: store.blockedPatterns(),
  };
}

function dedupeDeltas(deltas: readonly ParsedDelta[], report: CurationReport): ParsedDelta[] {
  const seen = new Set<string>();
  const kept: ParsedDelta[] = [];
  for (const delta of deltas) {
    const key = delta.type === "add" ? contentKey(delta.content) : JSON.stringify(delta);
    if (seen.has(key)) report.skipped.push({ delta, reason: "duplicate delta" });
    else {
      seen.add(key);
      kept.push(delta);
    }
  }
  return kept;
}

function applyDelta(ctx: Ctx, delta: ParsedDelta): void {
  switch (delta.type) {
    case "add":
      return applyAdd(ctx, delta);
    case "helpful":
    case "harmful":
      return applyFeedback(ctx, delta);
    case "replace":
      return applyReplace(ctx, delta);
    case "deprecate":
      return applyDeprecate(ctx, delta);
    case "merge":
      return applyMerge(ctx, delta);
  }
}

function applyAdd(ctx: Ctx, delta: AddDelta): void {
  if (isBlocked(ctx, delta.content)) {
    ctx.report.blocked.push(delta.content);
    return;
  }
  const live = ctx.store.list();
  const duplicate = findDuplicate(live, delta.content, ctx.nearDup);
  if (duplicate) {
    reinforce(ctx, duplicate.id, "restated by a new add");
    return;
  }
  const bullet = ctx.store.add({ ...addFields(delta), sourceSessions: ctx.provenance });
  ctx.report.added.push(bullet.id);
  detectConflicts(ctx, bullet, live);
}

function applyFeedback(ctx: Ctx, delta: Extract<ParsedDelta,{ type: "helpful" | "harmful" }>): void {
  if (!ctx.store.get(delta.bulletId)) {
    ctx.report.skipped.push({ delta, reason: "unknown bullet" });
    return;
  }
  ctx.store.recordFeedback(delta.bulletId, delta.type, { sessionRef: ctx.provenance[0]?.sessionRef, reason: delta.reason });
  (delta.type === "helpful" ? ctx.report.reinforced : ctx.report.penalized).push(delta.bulletId);
}

function applyReplace(ctx: Ctx, delta: Extract<ParsedDelta,{ type: "replace" }>): void {
  const old = ctx.store.get(delta.bulletId);
  if (!old) {
    ctx.report.skipped.push({ delta, reason: "unknown bullet" });
    return;
  }
  const next = ctx.store.add({ ...inherit(old), content: delta.content, reasoning: delta.reasoning ?? old.reasoning, sourceSessions: [...old.sourceSessions, ...ctx.provenance] });
  ctx.store.deprecate(old.id, "replaced", next.id);
  ctx.report.added.push(next.id);
  ctx.report.deprecated.push(old.id);
}

function applyDeprecate(ctx: Ctx, delta: Extract<ParsedDelta,{ type: "deprecate" }>): void {
  if (!ctx.store.get(delta.bulletId)) {
    ctx.report.skipped.push({ delta, reason: "unknown bullet" });
    return;
  }
  ctx.store.deprecate(delta.bulletId, delta.reason);
  ctx.report.deprecated.push(delta.bulletId);
}

function applyMerge(ctx: Ctx, delta: Extract<ParsedDelta,{ type: "merge" }>): void {
  const olds = delta.bulletIds.map((id) => ctx.store.get(id));
  const first = olds[0];
  if (!first || olds.some((b) => b === undefined)) {
    ctx.report.skipped.push({ delta, reason: "unknown bullet" });
    return;
  }
  const present = olds as Bullet[];
  const next = ctx.store.add({
    ...inherit(first),
    content: delta.content,
    tags: [...new Set(present.flatMap((b) => b.tags))],
    reasoning: delta.reasoning ?? first.reasoning,
    sourceSessions: [...present.flatMap((b) => b.sourceSessions), ...ctx.provenance],
  });
  ctx.report.added.push(next.id);
  for (const old of present) {
    ctx.store.deprecate(old.id, "merged", next.id);
    ctx.report.deprecated.push(old.id);
  }
}

function addFields(delta: AddDelta): Omit<AddDelta, "type"> {
  const { content, category, tags, scope, kind, isNegative, reasoning } = delta;
  return { content, category, tags, scope, kind, isNegative, reasoning };
}

function inherit(bullet: Bullet): Pick<Bullet, "category" | "tags" | "scope" | "type" | "kind" | "isNegative" | "source" | "halfLifeDays"> {
  const { category, tags, scope, type, kind, isNegative, source, halfLifeDays } = bullet;
  return { category, tags, scope, type, kind, isNegative, source, halfLifeDays };
}

function reinforce(ctx: Ctx, id: string, reason: string): void {
  ctx.store.recordFeedback(id, "helpful", { sessionRef: ctx.provenance[0]?.sessionRef, reason });
  ctx.report.reinforced.push(id);
}

function isBlocked(ctx: Ctx, content: string): boolean {
  const normalized = normalizeContent(content);
  return ctx.blocked.some((b) => normalizeContent(b.pattern) === normalized || jaccard(b.pattern, content) >= ctx.nearDup);
}

/** A near-duplicate with flipped polarity is a contradiction, not a restatement, so it never folds. */
function findDuplicate(live: readonly Bullet[], content: string, threshold: number): Bullet | undefined {
  const key = contentKey(content);
  const negated = isNegated(content);
  return (
    live.find((b) => contentKey(b.content) === key) ??
    live.find((b) => isNegated(b.content) === negated && jaccard(b.content, content) >= threshold)
  );
}

/** Heuristic only: similar wording where exactly one side is a prohibition. Warns, never blocks. */
function detectConflicts(ctx: Ctx, bullet: Bullet, others: readonly Bullet[]): void {
  const negated = isNegated(bullet.content);
  for (const other of others) {
    if (isNegated(other.content) === negated || jaccard(bullet.content, other.content) < ctx.conflict) continue;
    ctx.report.conflicts.push({ bulletId: bullet.id, otherId: other.id, reason: "similar wording with opposite polarity" });
  }
}

function shouldInvert(ctx: Ctx, bullet: ScoredBullet): boolean {
  if (bullet.type !== "rule" || bullet.pinned || bullet.state !== "active") return false;
  return bullet.decayedHarmful >= ctx.inversion.minHarmful && bullet.decayedHarmful > ctx.inversion.harmfulToHelpfulRatio * bullet.decayedHelpful;
}

function invertHarmfulRules(ctx: Ctx): void {
  for (const bullet of scorePlaybook(ctx.store, ctx.now())) {
    if (!shouldInvert(ctx, bullet)) continue;
    const avoid = ctx.store.add({
      ...inherit(bullet),
      content: `AVOID: ${bullet.content}`,
      type: "anti-pattern",
      kind: "anti_pattern",
      isNegative: true,
      reasoning: "inverted after repeated harmful feedback",
      sourceSessions: [...bullet.sourceSessions, ...ctx.provenance],
    });
    ctx.store.deprecate(bullet.id, "inverted to an anti-pattern", avoid.id);
    ctx.report.inverted.push({ from: bullet.id, to: avoid.id });
  }
}

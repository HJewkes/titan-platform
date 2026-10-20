/**
 * The gate strip (decision 489): every gate on a shepherded PR besides the owner's own approval, read at the PR's live head
 * and shown on every approval surface. It reads CI, reviewer verdicts, holds and other pending gates; anything recorded at
 * another head is shown but never counted, and a read that fails is an unknown row that always counts as unmet. Nothing
 * here writes: S3's round taps decide from `unmet`, by its stable keys.
 */
import { z } from "zod";
import { readCommand } from "./owner-guard.js";
import { mergesAt, mergesNeededFor, recordedVerdicts, type RecordedVerdict } from "./g10-hold.js";
import type { CheckRunsPage, ShepherdSource } from "./shepherd.js";

type WatchRow = Awaited<ReturnType<ShepherdSource["list"]>>[number];
type Waiting = Awaited<ReturnType<ShepherdSource["waiting"]>>;

/** One source's answer, or the reason it could not be read. */
export type StripRead<T> = { ok: true; value: T } | { ok: false; gap: string };

export interface StripInputs {
  row: WatchRow;
  timeline: StripRead<readonly unknown[]>;
  waiting: StripRead<Waiting>;
  checkRuns: StripRead<CheckRunsPage>;
}

interface CheckRow {
  name: string;
  state: "pass" | "fail" | "pending";
}

interface HoldRow {
  key: string;
  holdClass: string;
  reason: string;
  /** Who placed it, from the timeline's hold event or the repo freeze; null when no record names one. */
  actor: string | null;
  merges?: { present: number; needed: number };
}

interface OtherGateRow {
  key: string;
  stepId: string;
  gateId: string;
  since: string;
}

/** `key` is stable for S3's explicit skip: `ci:<check>`, `hold:<class>`, `verdict:<reviewer>`, `gate:<stepId>`, `unknown:<source>`. */
export interface UnmetGate {
  key: string;
  label: string;
}

export interface GateStrip {
  repo: string;
  pr: number;
  head: string;
  phase: string;
  /** The step of the gate the run waits on now, usually the owner's own approve-merge. */
  pendingGate: string | null;
  ci: { factory: { verdict: string; headSha: string; atHead: boolean } | null; checks: CheckRow[] };
  verdicts: RecordedVerdict[];
  holds: HoldRow[];
  otherGates: OtherGateRow[];
  unmet: UnmetGate[];
}

const OWNER_STEP = "approve-merge";
const PASSING = new Set(["success", "neutral", "skipped"]);

/** Read as Shepherd's `holdClassOf` reads it: the text before the first colon, untrimmed. */
export const holdClassOf = (reason: string): string | undefined => (reason.includes(":") ? reason.slice(0, reason.indexOf(":")) : undefined);

const ciEntry = z.looseObject({ kind: z.literal("ci"), headSha: z.string(), conclusion: z.string() });
const holdEvent = z.looseObject({ kind: z.literal("event"), event: z.literal("hold"), reason: z.string().nullable(), actor: z.string().nullable() });
const frozen = z.looseObject({ repoFrozen: z.looseObject({ reason: z.string(), actor: z.string() }) });

const checkState = (run: CheckRunsPage["check_runs"][number]): CheckRow["state"] => {
  if (run.status !== "completed") return "pending";
  return run.conclusion !== null && PASSING.has(run.conclusion) ? "pass" : "fail";
};

const checkRows = (page: CheckRunsPage): CheckRow[] => page.check_runs.map((run) => ({ name: run.name, state: checkState(run) }));

function factoryCi(entries: readonly unknown[], head: string): GateStrip["ci"]["factory"] {
  const newest = entries.flatMap((entry) => {
    const parsed = ciEntry.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }).at(-1);
  return newest === undefined ? null : { verdict: newest.conclusion, headSha: newest.headSha, atHead: newest.headSha === head };
}

/** The hold event that placed the live hold: the newest one with its reason, else the newest hold at all. */
function holdActor(entries: readonly unknown[], reason: string): string | null {
  const holds = entries.flatMap((entry) => {
    const parsed = holdEvent.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const placed = holds.filter((each) => each.reason === reason).at(-1) ?? holds.at(-1);
  return placed?.actor ?? null;
}

function holdRows(row: WatchRow, entries: readonly unknown[], verdicts: readonly RecordedVerdict[]): HoldRow[] {
  const rows: HoldRow[] = [];
  if (row.held !== null) {
    const holdClass = holdClassOf(row.held.reason) ?? "unclassed";
    const needed = mergesNeededFor(holdClass);
    const merges = needed === undefined ? {} : { merges: { present: mergesAt(verdicts), needed } };
    rows.push({ key: `hold:${holdClass}`, holdClass, reason: row.held.reason, actor: holdActor(entries, row.held.reason), ...merges });
  }
  const freeze = frozen.safeParse(row);
  if (freeze.success) rows.push({ key: "hold:freeze", holdClass: "freeze", reason: freeze.data.repoFrozen.reason, actor: freeze.data.repoFrozen.actor });
  return rows;
}

const baseStep = (stepId: string): string => stepId.replace(/:\d+$/, "");

function otherGateRows(row: WatchRow, waiting: Waiting): OtherGateRow[] {
  return [...waiting.owner, ...waiting.seat]
    .filter((gate) => gate.repo === row.repo && gate.pr === row.pr && baseStep(gate.stepId) !== OWNER_STEP)
    .map((gate) => ({ key: `gate:${baseStep(gate.stepId)}`, stepId: gate.stepId, gateId: gate.gateId, since: gate.since }));
}

const valueOr = <T>(read: StripRead<T>, fallback: T): T => (read.ok ? read.value : fallback);

const NO_WAITING: Waiting = { owner: [], seat: [] };
const NO_CHECKS: CheckRunsPage = { total_count: 0, check_runs: [] };

/** The pure read model: `row.headSha` is the head every other row is read at. */
export function gateStrip({ row, timeline, waiting, checkRuns }: StripInputs & { row: PinnedRow }): GateStrip {
  const head = row.headSha;
  const entries = valueOr(timeline, []);
  const verdicts = recordedVerdicts(entries, head);
  const ci = { factory: factoryCi(entries, head), checks: checkRows(valueOr(checkRuns, NO_CHECKS)) };
  const holds = holdRows(row, entries, verdicts);
  const otherGates = otherGateRows(row, valueOr(waiting, NO_WAITING));
  const strip = { repo: row.repo, pr: row.pr, head, phase: row.phase, pendingGate: row.pendingGate?.stepId ?? null, ci, verdicts, holds, otherGates };
  return { ...strip, unmet: unmetOf(strip, { timeline, waiting, checkRuns }) };
}

const unknownRows = (reads: Omit<StripInputs, "row">): UnmetGate[] =>
  Object.entries(reads).flatMap(([source, read]: [string, StripRead<unknown>]) => (read.ok ? [] : [{ key: `unknown:${source}`, label: `unknown ${source}: ${read.gap}` }]));

function ciUnmet({ factory, checks }: GateStrip["ci"], checksRead: boolean): UnmetGate[] {
  if (factory?.atHead === true && factory.verdict === "green") return [];
  const named = checks.filter((check) => check.state !== "pass").map((check) => ({ key: `ci:${check.name}`, label: `CI ${check.name} (${check.state === "fail" ? "failed" : "pending"})` }));
  if (named.length > 0 || !checksRead) return named;
  const reading = factory === null ? "no factory CI reading" : factory.atHead ? `factory CI reads ${factory.verdict}` : "factory CI read only at an older head";
  return [{ key: "ci:required", label: `CI: ${reading}` }];
}

/** A reviewer's newest verdict at the head stands; a FIX_FIRST there is a gate until that reviewer MERGEs. */
function verdictUnmet(verdicts: readonly RecordedVerdict[]): UnmetGate[] {
  const newest = new Map<string, RecordedVerdict>();
  for (const verdict of verdicts.filter((each) => each.atHead)) newest.set(verdict.reviewer ?? `step:${verdict.stepId}`, verdict);
  return [...newest].filter(([, verdict]) => verdict.verdict === "FIX_FIRST").map(([reviewer]) => ({ key: `verdict:${reviewer}`, label: `FIX_FIRST from ${reviewer}` }));
}

const holdLabel = (hold: HoldRow): string => {
  const merges = hold.merges === undefined ? "" : ` (${hold.merges.present}/${hold.merges.needed} MERGE)`;
  return `held: ${hold.holdClass}${merges} by ${hold.actor ?? "an unrecorded actor"}`;
};

const byKey = (gates: readonly UnmetGate[]): UnmetGate[] => [...new Map(gates.map((gate) => [gate.key, gate])).values()];

function unmetOf(strip: Omit<GateStrip, "unmet">, reads: Omit<StripInputs, "row">): UnmetGate[] {
  return byKey([
    ...unknownRows(reads),
    ...(reads.timeline.ok ? ciUnmet(strip.ci, reads.checkRuns.ok) : []),
    ...verdictUnmet(strip.verdicts),
    ...strip.holds.map((hold) => ({ key: hold.key, label: holdLabel(hold) })),
    ...strip.otherGates.map((gate) => ({ key: gate.key, label: `pending gate ${gate.stepId}` })),
  ]);
}

type PinnedRow = WatchRow & { pr: number; headSha: string };

const isPinned = (row: WatchRow): row is PinnedRow => row.pr !== null && row.headSha !== null;

async function settle<T>(read: () => Promise<T>): Promise<StripRead<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, gap: error instanceof Error ? error.message : String(error) };
  }
}

/** Plan risk: at most one read per PR head per window, so a polled inbox or a round with many PRs costs little quota. */
const STRIP_TTL_MS = 30_000;

export interface GateStripReader {
  /** One strip per pinned row, keyed by run id; `shepherd.waiting` is read once for all of them. */
  readMany(rows: readonly WatchRow[]): Promise<Map<string, GateStrip>>;
}

/** A strip with an unknown row is never kept, so the next read retries the source that failed. */
export function gateStripReader(shepherd: ShepherdSource, now: () => number = Date.now, ttlMs: number = STRIP_TTL_MS): GateStripReader {
  const kept = new Map<string, { at: number; strip: GateStrip }>();
  const fresh = (key: string): GateStrip | undefined => {
    const hit = kept.get(key);
    return hit !== undefined && now() - hit.at < ttlMs ? hit.strip : undefined;
  };
  async function readOne(row: PinnedRow, waiting: StripRead<Waiting>): Promise<GateStrip> {
    const [timeline, checkRuns] = await Promise.all([settle(async () => (await shepherd.timeline(row.repo, row.pr)).entries), settle(() => shepherd.checkRuns(row.repo, row.headSha))]);
    const strip = gateStrip({ row, timeline, waiting, checkRuns });
    if (strip.unmet.every((gate) => !gate.key.startsWith("unknown:"))) kept.set(`${row.repo}#${row.pr}@${row.headSha}`, { at: now(), strip });
    return strip;
  }
  async function readMany(rows: readonly WatchRow[]): Promise<Map<string, GateStrip>> {
    const pinned = rows.filter(isPinned);
    const stale = pinned.filter((row) => fresh(`${row.repo}#${row.pr}@${row.headSha}`) === undefined);
    const waiting = stale.length === 0 ? { ok: true as const, value: NO_WAITING } : await settle(() => shepherd.waiting());
    const strips = await Promise.all(pinned.map(async (row) => [row.runId, fresh(`${row.repo}#${row.pr}@${row.headSha}`) ?? (await readOne(row, waiting))] as const));
    return new Map(strips);
  }
  return { readMany };
}

/** `gates.strip`'s answer: the strip at the live head, or why there is none to show. */
type GateStripAnswer = { status: "ok"; strip: GateStrip } | { status: "none"; reason: string };

async function stripFor(shepherd: ShepherdSource, reader: GateStripReader, repo: string, pr: number): Promise<GateStripAnswer> {
  const rows = await settle(() => shepherd.list("active"));
  if (!rows.ok) return { status: "none", reason: `unknown shepherd: ${rows.gap}` };
  const row = rows.value.find((each) => each.repo === repo && each.pr === pr && isPinned(each));
  if (row === undefined) return { status: "none", reason: `no live Shepherd run pins ${repo}#${pr} to a head` };
  const strip = (await reader.readMany([row])).get(row.runId)!;
  return { status: "ok", strip };
}

export function gateStripCommands(shepherd: ShepherdSource, reader: GateStripReader) {
  return {
    "gates.strip": readCommand({
      name: "gates.strip",
      description: "Every gate on one shepherded PR besides the owner's approval, at its live head: CI, reviewer verdicts, holds and who placed them, other pending gates, and the unmet set",
      args: z.object({ repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repo"), pr: z.number().int().positive() }),
      result: z.custom<GateStripAnswer>(),
      run: ({ repo, pr }) => stripFor(shepherd, reader, repo, pr),
    }),
  };
}

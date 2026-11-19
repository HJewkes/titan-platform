/**
 * The deposit by-rec sweep (TP-6774, slice E of TP-6765): an open owner deposit that carries a recommended option and
 * that the owner left unanswered past its wait takes that option. The wait is the policy's `afterHours` (24 h by default),
 * or the deposit's own `onSilence apply-default afterHours`; `byRecDecision` in owner-queue decides, with its floor in code.
 *
 * The policy file `<stateDir>/auto-by-rec-policy.json` sets the mode. Absent, the mode is shadow: each eligible deposit
 * gets one `would-resolve` row in `<stateDir>/auto-by-rec.jsonl` and nothing else. Live, the answer is filed with
 * `writeAnswer`, the same once-only file an owner's console answer writes and the asker reads, then recorded in the
 * decision log and given one `resolved` row. A policy file that cannot be read turns the sweep off for that pass.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BY_REC_POLICY_SCHEMA, BY_REC_RESOLVER, BY_REC_ROW_SCHEMA, byRecDecision, byRecPolicySchema, byRecRowSchema, byRecSubjectOfItem, type ByRecPolicy, type ByRecRow, type OwnerAnswer, type OwnerItem } from "@titan-design/owner-queue";
import { writeAnswer } from "@titan-design/owner-queue/spool";
import { spoolQueueItems } from "./approval-items.js";
import type { DecisionLog } from "./decision-log.js";

const POLICY_FILE = "auto-by-rec-policy.json";
const LOG_FILE = "auto-by-rec.jsonl";
const MARKERS_DIR = "auto-by-rec";
const HOUR_MS = 3_600_000;
const JSON_FACTS = z.record(z.string(), z.json());
const BY_REC_ANSWERER = Object.freeze({ ...BY_REC_RESOLVER, channel: "console-sweep" } as const);

type SweepLogger = { warn(fields: Record<string, unknown>, message: string): void };

interface DepositSweepOptions {
  stateDir: string;
  inboxDir: string;
  decisionLog?: DecisionLog;
  now?: () => number;
  logger?: SweepLogger;
}

type Eligible = Extract<ReturnType<typeof byRecDecision>, { eligible: true }>;
type DepositOutcome = { id: string; result: "resolved" | "would-resolve" | "already" | "failed" } | { id: string; result: "skipped"; reason: string };

interface DepositSweepReport {
  mode: ByRecPolicy["mode"];
  outcomes: DepositOutcome[];
  gaps: string[];
}

interface SweepContext extends DepositSweepOptions {
  policy: ByRecPolicy;
  at: Date;
}

const errnoOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

/** A missing file is the shadow default; one that does not parse is off, so a typo never turns the sweep live. */
async function readPolicy(stateDir: string): Promise<{ policy: ByRecPolicy; gap?: string }> {
  const fallback = byRecPolicySchema.parse({ schema: BY_REC_POLICY_SCHEMA });
  try {
    const parsed = byRecPolicySchema.safeParse(JSON.parse(await readFile(path.join(stateDir, POLICY_FILE), "utf8")));
    if (parsed.success) return { policy: parsed.data };
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { policy: fallback };
  }
  return { policy: { ...fallback, mode: "off" }, gap: `${POLICY_FILE} could not be read; the deposit sweep is off` };
}

/** Facts as JSON values only: a field the deposit leaves out is left out here too. */
function factsOf(item: OwnerItem, decision: Eligible): ByRecRow["facts"] {
  const facts = { asker: item.asker, kind: item.kind, door: item.door, onSilence: item.onSilence, default: item.default, eligibleAt: decision.at, sources: item.sources };
  return JSON_FACTS.parse(JSON.parse(JSON.stringify(facts)));
}

function rowOf(ctx: SweepContext, item: OwnerItem, decision: Eligible, result: "would-resolve" | "resolved"): ByRecRow {
  const confidence = item.recommended?.confidence;
  return byRecRowSchema.parse({
    schema: BY_REC_ROW_SCHEMA,
    subject: { source: "deposit", id: item.id, summary: item.summary },
    recommendation: { answer: decision.answer, by: item.recommended?.by, rationale: decision.rationale, ...(confidence !== undefined && { confidence }) },
    openedAt: item.openedAt,
    resolvedAt: ctx.at.toISOString(),
    facts: factsOf(item, decision),
    mode: ctx.policy.mode,
    result,
    resolver: BY_REC_RESOLVER,
  });
}

async function appendRow(stateDir: string, row: ByRecRow): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await appendFile(path.join(stateDir, LOG_FILE), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

/** True only for the first call per deposit: the marker is created exclusively, so a restart never logs twice. */
async function firstShadow(stateDir: string, id: string): Promise<boolean> {
  const dir = path.join(stateDir, MARKERS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `deposit-${createHash("sha256").update(id).digest("hex").slice(0, 32)}.shadow`;
  try {
    await writeFile(path.join(dir, name), "", { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (errnoOf(error) === "EEXIST") return false;
    throw error;
  }
}

async function shadow(ctx: SweepContext, item: OwnerItem, decision: Eligible): Promise<DepositOutcome> {
  if (!(await firstShadow(ctx.stateDir, item.id))) return { id: item.id, result: "already" };
  await appendRow(ctx.stateDir, rowOf(ctx, item, decision, "would-resolve"));
  return { id: item.id, result: "would-resolve" };
}

/** The answer file is the once-guard: an owner answer filed first, or an earlier sweep's, leaves this one unwritten. */
async function resolve(ctx: SweepContext, item: OwnerItem, decision: Eligible): Promise<DepositOutcome> {
  const answer: OwnerAnswer = { optionId: decision.answer, by: BY_REC_ANSWERER, at: ctx.at.toISOString() };
  const { created } = await writeAnswer(ctx.inboxDir, item.id, answer);
  if (!created) return { id: item.id, result: "already" };
  await ctx.decisionLog?.record(item, answer);
  await appendRow(ctx.stateDir, rowOf(ctx, item, decision, "resolved"));
  return { id: item.id, result: "resolved" };
}

/** `byRecDecision` checks an answer against the options only when there are options, so a deposit without them is skipped here. */
async function sweepItem(ctx: SweepContext, item: OwnerItem): Promise<DepositOutcome> {
  if ((item.options ?? []).length === 0) return { id: item.id, result: "skipped", reason: "no-options" };
  const decision = byRecDecision(byRecSubjectOfItem(item), ctx.at, ctx.policy);
  if (!decision.eligible) return { id: item.id, result: "skipped", reason: decision.reason };
  try {
    return await (ctx.policy.mode === "live" ? resolve(ctx, item, decision) : shadow(ctx, item, decision));
  } catch (error) {
    ctx.logger?.warn({ error, item: item.id }, "deposit by-rec sweep: the item failed");
    return { id: item.id, result: "failed" };
  }
}

/** One pass over the spool's open deposits; answered, withdrawn and malformed ones never reach the policy. */
export async function sweepDeposits(options: DepositSweepOptions): Promise<DepositSweepReport> {
  const { policy, gap } = await readPolicy(options.stateDir);
  const gaps = gap === undefined ? [] : [gap];
  if (policy.mode === "off") return { mode: policy.mode, outcomes: [], gaps };
  const ctx: SweepContext = { ...options, policy, at: new Date((options.now ?? Date.now)()) };
  const spool = await spoolQueueItems(options.inboxDir);
  const outcomes: DepositOutcome[] = [];
  for (const item of spool.open) outcomes.push(await sweepItem(ctx, item));
  return { mode: policy.mode, outcomes, gaps: [...gaps, ...spool.gaps] };
}

/** Runs now and then hourly; a pass still running when the next is due is not doubled. */
export function startDepositByRecSweep(options: DepositSweepOptions, intervalMs = HOUR_MS): { stop(): void } {
  let running = false;
  const pass = (): void => {
    if (running) return;
    running = true;
    sweepDeposits(options)
      .catch((error: unknown) => options.logger?.warn({ error }, "deposit by-rec sweep failed"))
      .finally(() => (running = false));
  };
  pass();
  const timer = setInterval(pass, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

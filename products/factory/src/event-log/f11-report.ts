// Node strips this file's types when scripts/f11.mjs imports it, so it carries no runtime imports. The comparators it
// composes arrive as `engines` for the same reason: the script imports their modules, and so do the tests.
import type { RateRecord, ratePeaks } from "../github-api/rate-sample.js";
import type { UsageWindow } from "../github-api/usage-meter.js";
import type { agreement, CensusRow, DuplicateLine, kindCensus } from "./agreement.js";
import type { F11Window } from "./f11-window.js";

/** Every kind the ingress projects, RulesChanged included (ingress/kinds.ts); f11-report.test.ts pins this copy to it. */
export const F11_KINDS = ["BaseChanged", "CIConcluded", "HeadPushed", "MainMoved", "PRClosed", "PRMerged", "ReviewDismissed", "ReviewSubmitted", "RulesChanged"];
/** One default backstop interval plus the reconciler's due-check tick: how late a re-observation may come in clock 2. */
export const F11_WITHIN_MS = 300_000 + 15_000;
/** M1a's bound on either identity's peak share of a primary limit. */
const PEAK_BOUND_PCT = 50;
/** The disagree classes the reconciler logs; each is reported even at zero so a clean window reads as checked. */
const DISAGREE_CLASSES = ["stale-read", "field-parity", "main-ancestry-lost", "unconfirmed"];
const DUPLICATE_BY: readonly unknown[] = ["delivery", "occurrence", "unchanged"];
/** The HJewkes side is sampled outside serve (scripts/f11-rate-sample.mjs); serve's own lines name the bot. */
const SAMPLED_IDENTITY = "hjewkes";

type F11Clock = "polling" | "webhook";

export interface F11Input {
  clock: F11Clock;
  window: F11Window;
  rows: readonly CensusRow[];
  /** The serve log, one record per line, each led by an ISO timestamp (`journalctl -o short-iso`). */
  log: string;
  /** The HJewkes sampler's JSONL records. */
  rate: readonly RateRecord[];
  withinMs?: number;
}

interface F11Engines {
  kindCensus: typeof kindCensus;
  agreement: typeof agreement;
  ratePeaks: typeof ratePeaks;
}

interface LogLine {
  at: string;
  message: string;
  fields: Record<string, unknown>;
}

interface PeakSummary {
  identity: string;
  resource: string;
  used: number;
  limit: number;
  pct: number;
  reset: string;
  underBound: boolean;
}

interface CheckRunGroup {
  subject: string;
  name: string;
  rows: number;
  checkRunIds: number[];
}

interface F11Report {
  clock: F11Clock;
  window: F11Window;
  withinMs: number;
  census?: ReturnType<typeof kindCensus>;
  agreement?: ReturnType<typeof agreement>;
  epochs: { disagree: Record<string, number>; headRegression: number };
  /** Each (sha, check name) the window saw more than once: one id across rows means a re-run kept its id. */
  checkRuns: CheckRunGroup[];
  peaks: PeakSummary[];
  log: { lines: number; untimed: number; confirmed: number; costLines: number; deliveries: number; redeliveries: number };
}

const LEVELED = /\[(?:info|warn|error)\] (.*)$/;
const REGRESSION = /(?:^|\s)head-regression repo=/;
const STAMP = /^(\d{4}-\d{2}-\d{2}T\S+)/;

function stampOf(text: string): string | undefined {
  const token = STAMP.exec(text)?.[1];
  const ms = token === undefined ? Number.NaN : Date.parse(token);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDuplicateBy(by: unknown): by is DuplicateLine["by"] {
  return DUPLICATE_BY.includes(by);
}

function fieldsOf(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A daemon record is `[level] <message> <json fields>`; the head guard writes its finding as bare text. */
function recordOf(text: string): Omit<LogLine, "at"> | undefined {
  if (REGRESSION.test(text)) return { message: "head-regression", fields: {} };
  const body = LEVELED.exec(text)?.[1];
  if (body === undefined) return undefined;
  const split = body.indexOf(" {");
  return split === -1 ? { message: body, fields: {} } : { message: body.slice(0, split), fields: fieldsOf(body.slice(split + 1)) };
}

/** Untimed records cannot be placed in the window, so they are counted rather than guessed in or out. */
function windowLines(log: string, window: F11Window): { lines: LogLine[]; untimed: number } {
  const lines: LogLine[] = [];
  let untimed = 0;
  for (const text of log.split("\n")) {
    const record = recordOf(text);
    if (record === undefined) continue;
    const at = stampOf(text);
    if (at === undefined) untimed += 1;
    else if (at >= window.since && at < window.until) lines.push({ at, ...record });
  }
  return { lines, untimed };
}

function confirmedLines(lines: readonly LogLine[]): DuplicateLine[] {
  return lines.flatMap(({ at, message, fields: { seq, by } }) =>
    message === "reconciler.confirmed" && typeof seq === "number" && isDuplicateBy(by) ? [{ seq, by, at }] : [],
  );
}

function epochs(lines: readonly LogLine[]): F11Report["epochs"] {
  const disagree = Object.fromEntries(DISAGREE_CLASSES.map((name) => [name, 0]));
  for (const { message, fields } of lines) {
    if (message === "reconciler.disagree" && typeof fields.class === "string") disagree[fields.class] = (disagree[fields.class] ?? 0) + 1;
  }
  return { disagree, headRegression: lines.filter((line) => line.message === "head-regression").length };
}

function checkRuns(rows: readonly CensusRow[]): CheckRunGroup[] {
  const groups = new Map<string, CheckRunGroup>();
  for (const { kind, subject, keys } of rows) {
    if (kind !== "CIConcluded" || keys.type !== "check" || typeof keys.context !== "string") continue;
    const group = groups.get(`${subject}|${keys.context}`) ?? { subject, name: keys.context, rows: 0, checkRunIds: [] };
    group.rows += 1;
    if (typeof keys.checkRunId === "number" && !group.checkRunIds.includes(keys.checkRunId)) group.checkRunIds.push(keys.checkRunId);
    groups.set(`${subject}|${keys.context}`, group);
  }
  return [...groups.values()].filter((group) => group.rows > 1);
}

type IdentityWindow = UsageWindow & { identity: string };

/** serve's hourly `github-api.peak` lines; a window open across two lines appears in both, so the caller keeps its max. */
function loggedPeaks(lines: readonly LogLine[]): IdentityWindow[] {
  return lines.flatMap(({ message, fields: { identity, resource, used, limit, reset } }) => {
    if (message !== "github-api.peak" || typeof identity !== "string" || typeof resource !== "string") return [];
    if (typeof used !== "number" || typeof limit !== "number" || typeof reset !== "string") return [];
    return [{ identity, resource, used, limit, reset: Date.parse(reset) / 1000 }];
  });
}

function peakSummaries(windows: readonly IdentityWindow[]): PeakSummary[] {
  const top = new Map<string, IdentityWindow>();
  for (const window of windows) {
    const key = `${window.identity}|${window.resource}`;
    const held = top.get(key);
    if (held === undefined || window.used / window.limit > held.used / held.limit) top.set(key, window);
  }
  return [...top.values()].map(({ identity, resource, used, limit, reset }) => {
    const pct = Math.round((used * 100) / limit);
    return { identity, resource, used, limit, pct, reset: new Date(reset * 1000).toISOString(), underBound: used * 100 < limit * PEAK_BOUND_PCT };
  });
}

function sampledPeaks(input: F11Input, engines: F11Engines): IdentityWindow[] {
  const inWindow = input.rate.filter((record) => record.at >= input.window.since && record.at < input.window.until);
  return engines.ratePeaks(inWindow).map((window) => ({ ...window, identity: SAMPLED_IDENTITY }));
}

function logCounts(lines: readonly LogLine[], untimed: number, confirmed: number): F11Report["log"] {
  const named = (message: string) => lines.filter((line) => line.message === message);
  const deliveries = named("webhook delivery stored");
  return {
    lines: lines.length,
    untimed,
    confirmed,
    costLines: named("reconciler.cost").length,
    deliveries: deliveries.length,
    redeliveries: deliveries.filter((line) => line.fields.inserted === false).length,
  };
}

/** Clock 1 asks which kinds the backstop wrote; clock 2 asks how each webhook row stands against the backstop. */
export function f11Report(input: F11Input, engines: F11Engines): F11Report {
  const withinMs = input.withinMs ?? F11_WITHIN_MS;
  const { lines, untimed } = windowLines(input.log, input.window);
  const confirmed = confirmedLines(lines);
  const sources =
    input.clock === "polling"
      ? { census: engines.kindCensus(input.rows, F11_KINDS) }
      : { agreement: engines.agreement(input.rows, confirmed, { ingressKinds: new Set(F11_KINDS), withinMs, until: input.window.until }) };
  return {
    clock: input.clock,
    window: input.window,
    withinMs,
    ...sources,
    epochs: epochs(lines),
    checkRuns: checkRuns(input.rows),
    peaks: peakSummaries([...loggedPeaks(lines), ...sampledPeaks(input, engines)]),
    log: logCounts(lines, untimed, confirmed.length),
  };
}

/**
 * serve.err.log as systemd appends it carries no timestamps, so none of its records can be placed in the window and
 * clock 2 would call every due webhook row webhookOnly. A report built on such a log is refused, not printed.
 */
export function unplacedLog(report: F11Report): string | undefined {
  if (report.log.untimed === 0 || report.log.lines > 0) return undefined;
  return `f11: none of the serve log's ${report.log.untimed} records carries a leading ISO timestamp, so none can be placed in the window; stamp them (journalctl -o short-iso, or pipe through ts) and run again`;
}

const list = (values: readonly (string | number)[]): string => (values.length === 0 ? "none" : values.join(", "));

function sourceSection(report: F11Report): string[] {
  if (report.census !== undefined) return [`- seen kinds: ${list(report.census.seen)}`, `- missing kinds: ${list(report.census.missing)}`];
  const result = report.agreement;
  if (result === undefined) return [];
  return [
    `- matched: ${result.matched.length}`,
    `- webhookOnly: ${list(result.webhookOnly)}`,
    `- backstopOnly: ${list(result.backstopOnly)}`,
    `- pending: ${list(result.pending)}`,
    `- divergentKeys: ${result.divergentKeys.length === 0 ? "none" : result.divergentKeys.map((pair) => `${pair.webhook}/${pair.backstop}`).join(", ")}`,
  ];
}

/** The section pasted into the F11 record; the JSON beside it is the evidence. */
export function f11Markdown(report: F11Report): string {
  const disagree = Object.entries(report.epochs.disagree).map(([name, count]) => `${name} ${count}`);
  return [
    `## F11 ${report.clock} clock, ${report.window.since} to ${report.window.until}`,
    "",
    ...sourceSection(report),
    `- disagree: ${disagree.join(", ")}; head-regression ${report.epochs.headRegression}`,
    `- re-run check runs: ${report.checkRuns.length === 0 ? "none" : report.checkRuns.map((group) => `${group.subject} ${group.name} rows ${group.rows} ids ${group.checkRunIds.length}`).join("; ")}`,
    ...report.peaks.map((peak) => `- peak ${peak.identity} ${peak.resource}: ${peak.used}/${peak.limit} (${peak.pct}%) ${peak.underBound ? "under" : "AT OR OVER"} ${PEAK_BOUND_PCT}%`),
    `- log: ${report.log.lines} lines in window, ${report.log.untimed} untimed, ${report.log.costLines} cost lines, ${report.log.deliveries} deliveries (${report.log.redeliveries} redelivered)`,
    "",
  ].join("\n");
}

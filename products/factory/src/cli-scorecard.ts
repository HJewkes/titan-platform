import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readDispatchJournal, scorecardJournalRows, scorecardRowText, type DispatchRecord, type ScorecardRow } from "@titan-design/session-analytics";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Verbs } from "./cli.js";
import { stepIdMatches } from "./definition.js";
import { EXIT } from "./exit-codes.js";

const ROW_IDS = ["merges", "lead", "register", "cfr", "recovery", "rework", "mechanical", "breakglass", "queue", "autonomy", "cost"] as const;
type RowId = (typeof ROW_IDS)[number];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WAIT_MIN = 60;
const MINUTE_MS = 60_000;

const rowSpecSchema = z.object({ baseline: z.string().min(1), target: z.string().min(1).optional() }).strict();

/** The program data the scorecard measures against: window start, and a baseline (and optional target) per row. */
const specSchema = z
  .object({
    since: z.string().regex(DAY, "since must be YYYY-MM-DD"),
    rows: z.object(Object.fromEntries(ROW_IDS.map((id) => [id, rowSpecSchema])) as Record<RowId, typeof rowSpecSchema>).strict(),
  })
  .strict();
type ScorecardSpec = z.infer<typeof specSchema>;

export interface ScorecardSpecRow extends ScorecardRow {
  baseline: string;
  target?: string;
}

interface ScorecardOpts {
  since?: string;
  until?: string;
  spec?: string;
  json?: boolean;
}

interface Sources {
  eventsDb: string;
  logsDir: string;
  tasksDir: string;
}

interface ShepherdMerge {
  run: string;
  at: number;
  pr: string;
  task: string | undefined;
  human: boolean;
}

interface Window {
  since: number;
  now: number;
}

class UsageError extends Error {}

function loadSpec(file: string | undefined): ScorecardSpec {
  if (file === undefined) throw new UsageError("--spec <file> is required: the window start, baselines and targets live there, not in code");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read the spec ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const spec = specSchema.safeParse(parseYaml(text));
  if (!spec.success) throw new UsageError(`invalid spec ${file}: ${spec.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return spec.data;
}

/** The roots scripts/seat/scorecard reads: AUTONOMY_ROOT defaults under ACTIVE_ROOT, and the task root defaults three levels above it. */
function sourcesOf(env: NodeJS.ProcessEnv): Sources {
  const active = env.ACTIVE_ROOT || undefined;
  const autonomy = env.AUTONOMY_ROOT || (active && path.join(active, "claude-channels", "sources", "autonomy"));
  if (!autonomy) throw new UsageError("AUTONOMY_ROOT and ACTIVE_ROOT unset: export one");
  const agentChatHome = env.AGENT_CHAT_HOME || path.join(env.HOME || homedir(), ".agent-chat");
  return { eventsDb: path.join(agentChatHome, "events.db"), logsDir: path.join(autonomy, "logs"), tasksDir: active ?? path.dirname(path.dirname(path.dirname(autonomy))) };
}

/** An absent or unreadable store reads as no rows, so its scorecard rows print 'not measured'. */
function openReadOnly(file: string, warn: (text: string) => void): Db | null {
  if (!existsSync(file)) return null;
  try {
    return openDatabase(file, { readonly: true, foreignKeys: false });
  } catch (error) {
    warn(`scorecard: cannot read ${file}, its rows read as not measured: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}

function query<T>(db: Db | null, sql: string): T[] {
  if (!db) return [];
  try {
    return db.prepare(sql).all() as T[];
  } catch {
    return [];
  }
}

function parseTs(text: string): number {
  const iso = text.replace(/Z$/, "+00:00").replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  return Date.parse(/[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
}

function pct(part: number, whole: number): string {
  return `${((100 * part) / whole).toFixed(1)} percent (${part} of ${whole})`;
}

function quantile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const k = (s.length - 1) * q;
  const lo = Math.floor(k);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (k - lo);
}

const median = (values: readonly number[]): number => quantile(values, 0.5);

function normPr(repo: string, pr: unknown): string {
  return `${repo.toLowerCase().split("/").at(-1)}#${String(pr)}`;
}

const stepResultSchema = z.record(z.string(), z.object({ completedAt: z.string().optional(), data: z.unknown() }).passthrough());
const runParamsSchema = z.object({ repo: z.string().catch(""), pr: z.unknown(), task: z.string().optional().catch(undefined) }).passthrough();

const mergeDone = (data: unknown): boolean => z.object({ result: z.object({ done: z.literal(true) }) }).safeParse(data).success;

function shepherdMerge(id: string, params: string, steps: string, win: Window): ShepherdMerge | null {
  let p: z.infer<typeof runParamsSchema>, s: z.infer<typeof stepResultSchema>;
  try {
    p = runParamsSchema.parse(JSON.parse(params));
    s = stepResultSchema.parse(JSON.parse(steps));
  } catch {
    return null;
  }
  const merged = Object.entries(s).flatMap(([key, v]) => (key.startsWith("merge:") && mergeDone(v.data) && v.completedAt ? [v.completedAt] : []));
  if (!merged.length) return null;
  const at = parseTs(merged.sort().at(-1)!);
  if (at < win.since || at > win.now) return null;
  return { run: id, at, pr: normPr(p.repo, p.pr), task: p.task, human: Object.keys(s).some((key) => stepIdMatches("approve-merge", key)) };
}

/** Completed Shepherd runs whose merge step finished in the window, and whether a human approve-merge step was on the path. */
function shepherdMerges(db: Db | null, win: Window): ShepherdMerge[] {
  const runs = query<{ id: string; params: string; step_results: string }>(db, "SELECT id, params, step_results FROM workflow_run WHERE status = 'completed'");
  return runs.flatMap((r) => shepherdMerge(r.id, r.params, r.step_results, win) ?? []);
}

function mergedDispatches(records: readonly DispatchRecord[]): DispatchRecord[] {
  return records.filter((d) => d.outcome?.startsWith("merged") && d.pr);
}

function seatPrs(records: readonly DispatchRecord[]): Set<string> {
  return new Set(mergedDispatches(records).flatMap((d) => (d.pr!.includes("#") ? [normPr(d.pr!.slice(0, d.pr!.lastIndexOf("#")), d.pr!.slice(d.pr!.lastIndexOf("#") + 1))] : [])));
}

/** A task's `created:` date as UTC midnight; created is date-only, so lead times carry up to a day of slack. */
function taskCreated(tasksDir: string, task: string | undefined): number | null {
  const [slug, id] = (task ?? "").split("/", 2);
  if (!slug || !id) return null;
  try {
    const day = /^created:\s*(\d{4}-\d\d-\d\d)/m.exec(readFileSync(path.join(tasksDir, slug, "tasks", `${id}.yml`), "utf8"))?.[1];
    return day ? Date.parse(day) : null;
  } catch {
    return null;
  }
}

function mergesPerDay(shep: readonly ShepherdMerge[], win: Window): string | null {
  if (!shep.length) return null;
  const auto = shep.filter((m) => !m.human).length;
  const days = Math.max((win.now - win.since) / 86_400_000, 1);
  return `${(auto / days).toFixed(2)} per day (${auto} with no human step of ${shep.length} merges in ${days.toFixed(1)} days)`;
}

function readyToMerged(shep: readonly ShepherdMerge[], tasksDir: string): string | null {
  const mins = shep.flatMap((m) => {
    const created = taskCreated(tasksDir, m.task);
    return created === null ? [] : [(m.at - created) / MINUTE_MS];
  });
  if (!mins.length) return null;
  return `median ${median(mins).toFixed(0)} min, p90 ${quantile(mins, 0.9).toFixed(0)} min (n=${mins.length}; created is date-only)`;
}

function registerToMerge(db: Db | null, shep: readonly ShepherdMerge[]): string | null {
  const created = new Map(query<{ run_id: string; created_at: string }>(db, "SELECT run_id, created_at FROM shepherd_registration").map((r) => [r.run_id, r.created_at]));
  const mins = shep.flatMap((m) => (created.has(m.run) ? [(m.at - parseTs(created.get(m.run)!)) / MINUTE_MS] : []));
  return mins.length ? `median ${median(mins).toFixed(1)} min (n=${mins.length})` : null;
}

type Freeze = [frozen: number, thawed: number | null];

function freezes(db: Db | null, win: Window): Freeze[] {
  const rows = query<{ frozen_at: string; thawed_at: string | null }>(db, "SELECT frozen_at, thawed_at FROM shepherd_freeze");
  return rows.flatMap((r): Freeze[] => {
    const frozen = parseTs(r.frozen_at);
    return frozen >= win.since && frozen <= win.now ? [[frozen, r.thawed_at ? parseTs(r.thawed_at) : null]] : [];
  });
}

function changeFailure(frozen: readonly Freeze[], records: readonly DispatchRecord[], totalMerges: number): string | null {
  if (!totalMerges || (!frozen.length && !records.length)) return null;
  const reverts = mergedDispatches(records).filter((d) => /\brevert/i.test(`${d.task} ${d.note}`)).length;
  return `red main ${pct(frozen.length, totalMerges)}; reverts ${pct(reverts, totalMerges)}; post-merge audit defects not measured (no audit ledger)`;
}

function redTime(frozen: readonly Freeze[]): string | null {
  const thawed = frozen.flatMap(([f, t]) => (t === null ? [] : [(t - f) / MINUTE_MS]));
  if (!thawed.length) return null;
  const still = frozen.filter(([, t]) => t === null).length;
  return `median ${median(thawed).toFixed(0)} min over ${thawed.length} episodes (${still} still red)`;
}

function seatShare(shep: readonly ShepherdMerge[], records: readonly DispatchRecord[]): string | null {
  const shepherd = new Set(shep.map((m) => m.pr));
  const seat = [...seatPrs(records)].filter((pr) => !shepherd.has(pr));
  const total = seat.length + shepherd.size;
  return total ? pct(seat.length, total) : null;
}

/** Pending approve-merge gates, the whole backlog rather than the window, as an owner queue is read. */
function waitingApproved(db: Db | null, now: number): string | null {
  const gates = query<{ id: string; created_at: string }>(db, "SELECT id, created_at FROM hitl_gate WHERE status = 'pending'");
  const waiting = gates.filter((g) => stepIdMatches("approve-merge", g.id.slice(g.id.lastIndexOf("/") + 1))).map((g) => parseTs(g.created_at));
  if (!waiting.length) return null;
  const old = waiting.filter((c) => (now - c) / MINUTE_MS > WAIT_MIN);
  const oldest = old.length ? `, oldest ${((now - Math.min(...old)) / 3_600_000).toFixed(0)} hours` : "";
  return `${old.length} PRs over ${WAIT_MIN} min${oldest}`;
}

function factoryRows(db: Db | null, records: readonly DispatchRecord[], tasksDir: string, win: Window): Record<Exclude<RowId, "rework" | "mechanical" | "autonomy" | "cost">, ScorecardRow> {
  const inWindow = records.filter((d) => d.at >= win.since && d.at <= win.now);
  const shep = shepherdMerges(db, win);
  const frozen = freezes(db, win);
  const total = new Set([...seatPrs(inWindow), ...shep.map((m) => m.pr)]).size;
  const row = (id: string, metric: string, value: string | null, source: string): ScorecardRow => ({ id, metric, value, source, measured: value !== null });
  return {
    merges: row("merges", "Merges per day by Shepherd with no human step", mergesPerDay(shep, win), "factory.sqlite3"),
    lead: row("lead", "Task ready to merged", readyToMerged(shep, tasksDir), "task created, ledger merge time"),
    register: row("register", "Register to merge", registerToMerge(db, shep), "Shepherd ledger"),
    cfr: row("cfr", "Change failure rate", changeFailure(frozen, inWindow, total), "shepherd_freeze, dispatch.jsonl"),
    recovery: row("recovery", "Time main stays red", redTime(frozen), "shepherd_freeze"),
    breakglass: row("breakglass", "Share of merges by seat merge script", seatShare(shep, inWindow), "dispatch.jsonl, ledger"),
    queue: row("queue", "Approved and waiting over 60 minutes", waitingApproved(db, win.now), "hitl_gate"),
  };
}

/** Every row, in scripts/seat/scorecard's order, with its baseline and target from the spec. */
export function scorecardRows(factoryDb: string, sources: Sources, spec: ScorecardSpec, since: string, now: number, warn: (text: string) => void): ScorecardSpecRow[] {
  const fdb = openReadOnly(factoryDb, warn);
  const edb = openReadOnly(sources.eventsDb, warn);
  try {
    const records = readDispatchJournal(sources.logsDir);
    const win = { since: Date.parse(since), now };
    const journal = scorecardJournalRows({ eventsDb: edb, dispatchRecords: records, since, now: new Date(now).toISOString() });
    const byId: Record<string, ScorecardRow> = { ...factoryRows(fdb, records, sources.tasksDir, win), ...Object.fromEntries(journal.map((r) => [r.id, r])) };
    return ROW_IDS.map((id) => ({ ...byId[id]!, ...spec.rows[id] }));
  } finally {
    fdb?.close();
    edb?.close();
  }
}

function formatText(since: string, rows: readonly ScorecardSpecRow[]): string {
  const line = (r: ScorecardSpecRow): string => `SCORECARD ${r.metric}: ${scorecardRowText(r)} | source ${r.source} | baseline ${r.baseline}${r.target ? ` | target ${r.target}` : ""}`;
  return `${[`SCORECARD since ${since}`, ...rows.map(line)].join("\n")}\n`;
}

function windowOf(opts: ScorecardOpts, spec: ScorecardSpec, now: () => number): { since: string; now: number } {
  const since = opts.since ?? spec.since;
  if (!DAY.test(since)) throw new UsageError(`expected YYYY-MM-DD for --since, got ${JSON.stringify(since)}`);
  const end = opts.until === undefined ? now() : Date.parse(opts.until);
  if (Number.isNaN(end)) throw new UsageError(`expected an ISO time for --until, got ${JSON.stringify(opts.until)}`);
  return { since, now: end };
}

function scorecardAction(opts: ScorecardOpts, { io, dbPath, setExit }: Verbs, now: () => number): void {
  try {
    const spec = loadSpec(opts.spec);
    const sources = sourcesOf(io.env);
    const win = windowOf(opts, spec, now);
    const rows = scorecardRows(dbPath(), sources, spec, win.since, win.now, io.stderr);
    io.stdout(opts.json ? `${JSON.stringify({ since: win.since, until: new Date(win.now).toISOString(), rows }, null, 2)}\n` : formatText(win.since, rows));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`error: ${error.message}\n`);
    setExit(EXIT.USAGE);
  }
}

/** `titan-factory scorecard`: the W41 scorecard rows from the factory ledger, events.db verdicts and seat journals, every source read-only. */
export function registerScorecard(program: Command, verbs: Verbs, now: () => number = Date.now): void {
  program
    .command("scorecard")
    .description("the factory scorecard: merges per day, lead and register-to-merge times, change failure, red time, rework, mechanical blockers, seat merge share, approval queue, coordinator autonomy and cost per merge; a row with no source prints 'not measured'")
    .option("--spec <file>", "YAML or JSON spec: since (YYYY-MM-DD) and rows.<id>.baseline and optional .target for every row (required)")
    .option("--since <date>", "window start, YYYY-MM-DD (UTC); overrides the spec's since")
    .option("--until <time>", "window end, an ISO time (default now)")
    .option("--json", "print the rows as JSON")
    .action((opts: ScorecardOpts) => scorecardAction(opts, verbs, now));
}

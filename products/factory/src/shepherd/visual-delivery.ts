import { constants } from "node:fs";
import { lstat, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { execSafeAsync, type SafeExecResult } from "@titan-design/agent-dispatch";
import { z } from "zod";
import type { DigestPushConfig } from "../config.js";
import { ntfyPublish, type NtfyDeps, type NtfyMessage } from "../ntfy.js";
import { resolveCheckout } from "./reviewer-dispatch.js";
import type { RosterReader } from "./roster.js";
import { packagerName, packetDirFor } from "./visual-packet-trigger.js";

/** One bound for every titan-review and titan-console exec, so a hung child never holds the sweep. */
const EXEC_TIMEOUT_MS = 120_000;
export const DEFAULT_READY_TIMEOUT_MS = 45 * 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
/** O_NONBLOCK so a planted FIFO cannot hang the open; O_NOFOLLOW so a symlinked file is refused, not followed. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** `imported` is not final: it is carried on to `delivered`, so a crash between the two replays the push step, not the import. */
const FINAL: ReadonlySet<string> = new Set<DeliveryRecord["state"]>(["shadow", "cancelled", "failed", "delivered", "withdrawn", "answered"]);
/** The channel a console Ship answer resolves its gate with (`gate-answer-rpc.ts`); that round is answered, never withdrawn. */
const SHIP_CHANNEL = "console:ship";
const NO_PUSH = "no push config";
const HEX40 = /^[0-9a-f]{40}$/;
const IMPORT_CONFLICT = /is already imported with a different/;

export type DeliveryExec = (argv: readonly string[], signal: AbortSignal) => Promise<SafeExecResult>;

export interface VisualDeliveryPorts {
  mode: "shadow" | "on";
  stateDir: string;
  /** `shepherd.titanReviewBin`, absolute; never looked up on PATH. */
  titanReviewBin: string;
  /** `visualDelivery.console`: the argv prefix that runs titan-console, e.g. node and its cli.js. */
  console: readonly string[];
  roster: RosterReader;
  cwdFor: (repo: string) => string | undefined;
  exec: DeliveryExec;
  now: () => number;
  readyTimeoutMs: number;
  /** The ntfy topic for the delivery and withdrawn lines: `visualDelivery.push`, else `digest.push`. Absent, a delivery records `no push config`. */
  push?: DigestPushConfig;
  /** `visualDelivery.origins` and `.url`: the click link is `<origins[urlKind]>/#/rounds/<id>`; without origins it is the import's own LAN URL. */
  origins?: { lan: string; tailnet?: string };
  urlKind?: "lan" | "tailnet";
  ntfy?: NtfyDeps;
}

export interface DeliveryGate {
  runId: string;
  gateId: string;
  headSha: string;
  /** When the gate opened, in ms: the packager was spawned just before it. */
  openedAt: number;
}

export type PrNow = { repo: string; pr: number; headSha: string; open: boolean } | "gone" | "unreadable";

/** What the sweep reads from the factory: the run's PR live, and whether the gate still waits. */
export interface DeliveryWorld {
  pr(runId: string): Promise<PrNow>;
  pending(gateId: string): boolean;
  /** The channel the gate was resolved with; absent while pending, or when it was cancelled. */
  resolvedVia(gateId: string): string | undefined;
}

const LintProblem = z.looseObject({ rule: z.string(), message: z.string() });
const LintResult = z.strictObject({ schema: z.literal("titan-review/packet-lint@1"), ok: z.boolean(), packetId: z.string().nullable(), problems: z.array(LintProblem) });
const ImportResult = z.looseObject({ id: z.string().min(1), created: z.boolean(), frames: z.number().int().nonnegative(), url: z.string(), lanUrl: z.string().nullable() });
const WithdrawResult = z.looseObject({ outcome: z.enum(["withdrawn", "already-withdrawn", "kept-answered"]) });
const Recorded = z.looseObject({ state: z.string(), reason: z.string().optional() });
const Where = { repo: z.string(), pr: z.number().int() };
const ImportedRecord = z.looseObject({ state: z.literal("imported"), packetId: z.string(), roundId: z.string(), frames: z.number(), url: z.string(), lanUrl: z.string().nullable(), ...Where });
const DeliveredRecord = z.looseObject({ state: z.literal("delivered"), roundId: z.string(), runId: z.string(), gateId: z.string(), headSha: z.string(), ...Where });

type DeliveryRecord =
  | { state: "shadow"; packetId: string }
  | { state: "imported"; packetId: string; roundId: string; created: boolean; frames: number; url: string; lanUrl: string | null; repo: string; pr: number }
  | { state: "delivered"; packetId: string; roundId: string; url: string; repo: string; pr: number; runId: string; gateId: string; headSha: string; pushWarning?: string }
  | { state: "withdrawn"; roundId: string; reason: string; outcome: string; pushWarning?: string }
  | { state: "answered"; roundId: string }
  | { state: "cancelled"; reason: string }
  | { state: "failed"; reason: string; detail?: string; problems?: z.infer<typeof LintProblem>[] };

export type DeliveryOutcome = { gateId: string; state: "waiting" | "refused" | DeliveryRecord["state"]; reason?: string };

type Imported = Extract<DeliveryRecord, { state: "imported" }>;
type Delivered = Extract<DeliveryRecord, { state: "delivered" }>;
type Step<T> = { record: DeliveryRecord } | { waiting: true } | { value: T };

export const deliveryFileFor = (stateDir: string, runId: string, headSha: string): string => `${packetDirFor(stateDir, runId, headSha)}.delivery.json`;

/** A gate with no packet dir is not a visual one and is left alone; a refused state file is reported, never followed. */
export async function deliverGate(ports: VisualDeliveryPorts, world: DeliveryWorld, gate: DeliveryGate, signal: AbortSignal): Promise<DeliveryOutcome | undefined> {
  const packetDir = packetDirFor(ports.stateDir, gate.runId, gate.headSha);
  if (!(await lstat(packetDir).catch(() => undefined))?.isDirectory()) return undefined;
  const file = deliveryFileFor(ports.stateDir, gate.runId, gate.headSha);
  const recorded = await readJson(file, Recorded).catch((error: unknown) => messageOf(error));
  if (typeof recorded === "string") return { gateId: gate.gateId, state: "refused", reason: recorded };
  if (recorded && isFinal(recorded.state)) return { gateId: gate.gateId, state: recorded.state, ...(recorded.reason !== undefined && { reason: recorded.reason }) };
  const replay = recorded?.state === "imported" ? ImportedRecord.safeParse(recorded) : undefined;
  if (replay && !replay.success) return { gateId: gate.gateId, state: "refused", reason: `${file} is an imported record that does not parse` };
  const step = replay ? { value: { ...replay.data, created: false } as Imported } : await pipeline(ports, world, gate, packetDir, signal);
  if ("waiting" in step) return { gateId: gate.gateId, state: "waiting" };
  const record = "record" in step ? step.record : step.value;
  if (!replay) await writeRecord(file, { ...record, at: stamp(ports) });
  const next = record.state === "imported" ? await deliver(ports, file, gate, record) : record;
  return { gateId: gate.gateId, state: next.state, ...("reason" in next && { reason: next.reason }) };
}

async function pipeline(ports: VisualDeliveryPorts, world: DeliveryWorld, gate: DeliveryGate, dir: string, signal: AbortSignal): Promise<Step<DeliveryRecord>> {
  const ready = await readiness(ports, gate, dir);
  if (!("value" in ready)) return ready;
  const first = await stillAsked(world, gate);
  if (!("value" in first)) return first;
  const checkout = resolveCheckout(first.value.repo, ports.cwdFor(first.value.repo));
  if ("problem" in checkout) return failed("no-clone", checkout.problem);
  const built = await buildAndLint(ports, gate, dir, checkout.dir, signal);
  if (!("value" in built)) return built;
  const second = await stillAsked(world, gate);
  if (!("value" in second)) return second;
  if (ports.mode === "shadow") return { value: { state: "shadow", packetId: built.value } };
  return importRound(ports, dir, built.value, second.value, signal);
}

/** Ready once prose.json is written and the packager has left a roster that was actually read (R8): a failed read is not ready. */
async function readiness(ports: VisualDeliveryPorts, gate: DeliveryGate, dir: string): Promise<Step<true>> {
  const prose = (await lstat(join(dir, "prose.json")).catch(() => undefined))?.isFile() === true;
  const roster = prose ? await ports.roster.read() : undefined;
  const packager = packagerName(gate.runId, gate.headSha);
  if (roster?.kind === "known" && !roster.rows.some((row) => row.name === packager)) return { value: true };
  if (ports.now() - gate.openedAt > ports.readyTimeoutMs) return failed("packet-incomplete", prose ? "the packager is still on the roster" : "no prose.json");
  return { waiting: true };
}

/** Cancel checks 1 and 2: GitHub's live PR head must still be the gate's, and the gate must still wait. An unreadable PR waits a tick. */
async function stillAsked(world: DeliveryWorld, gate: DeliveryGate): Promise<Step<{ repo: string; pr: number }>> {
  const pr = await world.pr(gate.runId);
  if (pr === "unreadable") return { waiting: true };
  if (pr === "gone" || !pr.open || !world.pending(gate.gateId)) return { record: { state: "cancelled", reason: "gate-gone" } };
  if (pr.headSha !== gate.headSha) return { record: { state: "cancelled", reason: `new-head:${pr.headSha}` } };
  return { value: { repo: pr.repo, pr: pr.pr } };
}

/** Lint is the factory's own integrity check: exit 0 or 3 carries valid JSON, and only `ok` with packet.json's own packetId passes. */
async function buildAndLint(ports: VisualDeliveryPorts, gate: DeliveryGate, dir: string, clone: string, signal: AbortSignal): Promise<Step<string>> {
  const round = await run(ports, [ports.titanReviewBin, "packet", "round", dir], signal);
  if (round.status !== 0) return failed("round", round.detail);
  const lint = await run(ports, [ports.titanReviewBin, "packet", "lint", dir, "--gate-head", gate.headSha, "--require", "prose,round", "--clone", clone, "--json"], signal);
  const parsed = lint.status === 0 || lint.status === 3 ? parseJson(lint.stdout, LintResult) : undefined;
  if (!parsed) return failed("lint-error", lint.detail || "packet lint printed no packet-lint@1 result");
  if (!parsed.ok || lint.status !== 0) return { record: { state: "failed", reason: "lint", problems: parsed.problems.slice(0, 20) } };
  const packet = await readJson(join(dir, "packet.json"), z.looseObject({ packetId: z.string() })).catch(() => undefined);
  if (!packet || parsed.packetId !== packet.packetId) return failed("lint", `lint passed packetId ${parsed.packetId}, not packet.json's ${packet?.packetId ?? "(unreadable)"}`);
  return { value: packet.packetId };
}

/** `created:false` is the crash-replay re-import of the same round, so it records `imported` too. */
async function importRound(ports: VisualDeliveryPorts, dir: string, packetId: string, where: { repo: string; pr: number }, signal: AbortSignal): Promise<Step<DeliveryRecord>> {
  const result = await run(ports, [...ports.console, "rounds", "import", dir, "--json"], signal);
  if (result.status !== 0) return failed(IMPORT_CONFLICT.test(result.detail) ? "import-conflict" : "import", result.detail);
  const report = parseJson(result.stdout, ImportResult);
  if (!report) return failed("import", "rounds import printed no import report");
  return { value: { state: "imported", packetId, roundId: report.id, created: report.created, frames: report.frames, url: report.url, lanUrl: report.lanUrl, ...where } };
}

const clickUrl = (ports: VisualDeliveryPorts, imported: Imported): string | undefined => {
  const origin = ports.origins?.[ports.urlKind ?? "lan"];
  return origin === undefined ? (imported.lanUrl ?? undefined) : `${origin.replace(/\/+$/, "")}/#/rounds/${imported.roundId}`;
};

/** Step 8: the `delivered` record is written first, so a crash replays to no second push; a failed push only adds a warning, and is never retried. */
async function deliver(ports: VisualDeliveryPorts, file: string, gate: DeliveryGate, imported: Imported): Promise<Delivered> {
  const click = clickUrl(ports, imported);
  const { packetId, roundId, repo, pr } = imported;
  const delivered: Delivered = { state: "delivered", packetId, roundId, url: click ?? imported.url, repo, pr, runId: gate.runId, gateId: gate.gateId, headSha: gate.headSha };
  await writeRecord(file, { ...delivered, ...(!ports.push && { pushWarning: NO_PUSH }), at: stamp(ports) });
  const message = { title: `Visual review: ${repo}#${pr}`, message: `${imported.frames} images at ${gate.headSha.slice(0, 8)}`, ...(click && { click }) };
  const warning = await pushLine(ports, message);
  if (warning && ports.push) await writeRecord(file, { ...delivered, pushWarning: warning, at: stamp(ports) });
  return delivered;
}

async function pushLine(ports: VisualDeliveryPorts, message: NtfyMessage): Promise<string | undefined> {
  if (!ports.push) return NO_PUSH;
  const result = await ntfyPublish(ports.push, message, ports.ntfy);
  return result.ok ? undefined : result.warning;
}

/** Step 9: a delivered round whose gate no longer waits is withdrawn, unless the console's own Ship answer settled it. */
export async function withdrawDelivered(ports: VisualDeliveryPorts, world: DeliveryWorld, signal: AbortSignal): Promise<DeliveryOutcome[]> {
  if (ports.mode !== "on") return [];
  const outcomes: DeliveryOutcome[] = [];
  for (const file of await deliveryFiles(ports.stateDir)) {
    const record = await readJson(file, DeliveredRecord).catch(() => undefined);
    if (!record || world.pending(record.gateId)) continue;
    const outcome = await withdrawOne(ports, world, file, record, signal);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

async function withdrawOne(ports: VisualDeliveryPorts, world: DeliveryWorld, file: string, record: z.infer<typeof DeliveredRecord>, signal: AbortSignal): Promise<DeliveryOutcome | undefined> {
  const { gateId, roundId } = record;
  if (world.resolvedVia(gateId) === SHIP_CHANNEL) return finish(ports, file, gateId, { state: "answered", roundId });
  const reason = await withdrawReason(world, record);
  if (reason === undefined) return undefined;
  const result = await run(ports, [...ports.console, "rounds", "withdraw", roundId, "--reason", reason, "--json"], signal);
  const outcome = result.status === 0 ? parseJson(result.stdout, WithdrawResult)?.outcome : undefined;
  if (!outcome) return finish(ports, file, gateId, { state: "failed", reason: "withdraw", detail: result.detail || "rounds withdraw printed no outcome" });
  const withdrawn: Extract<DeliveryRecord, { state: "withdrawn" }> = { state: "withdrawn", roundId, reason, outcome };
  await writeRecord(file, { ...withdrawn, at: stamp(ports) });
  const line = withdrawLine(record, reason);
  const warning = outcome === "withdrawn" && line ? await pushLine(ports, line) : undefined;
  if (warning && ports.push) await writeRecord(file, { ...withdrawn, pushWarning: warning, at: stamp(ports) });
  return { gateId, state: "withdrawn", reason };
}

/** Undefined while the PR cannot be read, so the next tick tries again. */
async function withdrawReason(world: DeliveryWorld, record: z.infer<typeof DeliveredRecord>): Promise<string | undefined> {
  const pr = await world.pr(record.runId);
  if (pr === "unreadable") return undefined;
  if (pr === "gone" || !pr.open) return "closed";
  return pr.headSha === record.headSha ? "answered-elsewhere" : `new-head:${pr.headSha}`;
}

/** Only a moved head or a closed PR is worth a second line; an answer given elsewhere stays silent. */
function withdrawLine(record: z.infer<typeof DeliveredRecord>, reason: string): NtfyMessage | undefined {
  const head = reason.startsWith("new-head:") ? reason.slice("new-head:".length) : undefined;
  if (reason !== "closed" && !(head && HEX40.test(head))) return undefined;
  return { title: `Visual review withdrawn: ${record.repo}#${record.pr}`, message: head ? `new head ${head.slice(0, 8)}` : "PR closed" };
}

async function finish(ports: VisualDeliveryPorts, file: string, gateId: string, record: DeliveryRecord): Promise<DeliveryOutcome> {
  await writeRecord(file, { ...record, at: stamp(ports) });
  return { gateId, state: record.state, ...("reason" in record && { reason: record.reason }) };
}

/** `<state>/packets/<run>/<head>.delivery.json`, whichever runs have any. */
async function deliveryFiles(stateDir: string): Promise<string[]> {
  const root = join(stateDir, "packets");
  const runs = await readdir(root).catch(() => []);
  const perRun = await Promise.all(runs.map(async (run) => (await readdir(join(root, run)).catch(() => [])).filter((name) => name.endsWith(".delivery.json")).map((name) => join(root, run, name))));
  return perRun.flat();
}

/** An exec that throws (timeout, could not start) reads as status -1, so every step records why it stopped. */
async function run(ports: VisualDeliveryPorts, argv: readonly string[], signal: AbortSignal): Promise<{ status: number; stdout: string; detail: string }> {
  try {
    const { status, stdout, stderr } = await ports.exec(argv, signal);
    return { status, stdout, detail: status === 0 ? "" : `exit ${status}: ${firstLine(stderr)}` };
  } catch (error) {
    return { status: -1, stdout: "", detail: messageOf(error) };
  }
}

export function systemDeliveryExec(roundsDir: string | undefined): DeliveryExec {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const withRounds = roundsDir === undefined ? env : { ...env, TITAN_CONSOLE_ROUNDS_DIR: roundsDir };
  return ([bin, ...args], signal) => execSafeAsync(bin!, args, withRounds, EXEC_TIMEOUT_MS, undefined, undefined, signal);
}

const stamp = (ports: VisualDeliveryPorts): string => new Date(ports.now()).toISOString();
const isFinal = (state: string): state is DeliveryRecord["state"] => FINAL.has(state);
const failed = (reason: string, detail: string): { record: DeliveryRecord } => ({ record: { state: "failed", reason, detail } });
const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 300) ?? "";
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function parseJson<T>(text: string, schema: z.ZodType<T>): T | undefined {
  try {
    return schema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

/** No file reads undefined; a symlink, a non-regular file or an oversized one throws, so it is refused rather than followed. */
async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const handle = await open(file, OPEN_FLAGS).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new Error(error.code === "ELOOP" ? `${file} is a symlink` : `${file} could not be opened`);
  });
  if (!handle) return undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_JSON_BYTES) throw new Error(`${file} is not a regular file under ${MAX_JSON_BYTES} bytes`);
    const parsed = parseJson(await handle.readFile("utf8"), schema);
    if (parsed === undefined) throw new Error(`${file} does not parse`);
    return parsed;
  } finally {
    await handle.close();
  }
}

/** tmp + rename, 0600: a crash leaves the old record or the new one, never half of either; a symlink planted at the tmp name is refused. */
async function writeRecord(file: string, record: DeliveryRecord & { at: string }): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

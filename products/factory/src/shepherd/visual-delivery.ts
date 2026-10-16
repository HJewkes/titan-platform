import { constants } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { execSafeAsync, type SafeExecResult } from "@titan-design/agent-dispatch";
import { z } from "zod";
import { resolveCheckout } from "./reviewer-dispatch.js";
import type { RosterReader } from "./roster.js";
import { packagerName, packetDirFor } from "./visual-packet-trigger.js";

/** One bound for every titan-review and titan-console exec, so a hung child never holds the sweep. */
const EXEC_TIMEOUT_MS = 120_000;
export const DEFAULT_READY_TIMEOUT_MS = 45 * 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
/** O_NONBLOCK so a planted FIFO cannot hang the open; O_NOFOLLOW so a symlinked file is refused, not followed. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** S5 carries `imported` on to `delivered`; until then an imported round is as far as the sweep goes. */
const FINAL = new Set(["shadow", "imported", "cancelled", "failed"]);
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
}

export interface DeliveryGate {
  runId: string;
  gateId: string;
  headSha: string;
  /** When the gate opened, in ms: the packager was spawned just before it. */
  openedAt: number;
}

export type PrNow = { repo: string; headSha: string; open: boolean } | "gone" | "unreadable";

/** What the sweep reads from the factory: the run's PR live, and whether the gate still waits. */
export interface DeliveryWorld {
  pr(runId: string): Promise<PrNow>;
  pending(gateId: string): boolean;
}

const LintProblem = z.looseObject({ rule: z.string(), message: z.string() });
const LintResult = z.strictObject({ schema: z.literal("titan-review/packet-lint@1"), ok: z.boolean(), packetId: z.string().nullable(), problems: z.array(LintProblem) });
const ImportResult = z.looseObject({ id: z.string().min(1), created: z.boolean(), url: z.string(), lanUrl: z.string().nullable() });
const Recorded = z.looseObject({ state: z.string(), reason: z.string().optional() });

export type DeliveryRecord =
  | { state: "shadow"; packetId: string }
  | { state: "imported"; packetId: string; roundId: string; created: boolean; url: string; lanUrl: string | null }
  | { state: "cancelled"; reason: string }
  | { state: "failed"; reason: string; detail?: string; problems?: z.infer<typeof LintProblem>[] };

export type DeliveryOutcome = { gateId: string; state: "waiting" | "refused" | DeliveryRecord["state"]; reason?: string };

type Step<T> = { record: DeliveryRecord } | { waiting: true } | { value: T };

export const deliveryFileFor = (stateDir: string, runId: string, headSha: string): string => `${packetDirFor(stateDir, runId, headSha)}.delivery.json`;

/** A gate with no packet dir is not a visual one and is left alone; a refused state file is reported, never followed. */
export async function deliverGate(ports: VisualDeliveryPorts, world: DeliveryWorld, gate: DeliveryGate, signal: AbortSignal): Promise<DeliveryOutcome | undefined> {
  const packetDir = packetDirFor(ports.stateDir, gate.runId, gate.headSha);
  if (!(await lstat(packetDir).catch(() => undefined))?.isDirectory()) return undefined;
  const file = deliveryFileFor(ports.stateDir, gate.runId, gate.headSha);
  const recorded = await readJson(file, Recorded).catch((error: unknown) => messageOf(error));
  if (typeof recorded === "string") return { gateId: gate.gateId, state: "refused", reason: recorded };
  if (recorded && FINAL.has(recorded.state)) return { gateId: gate.gateId, ...(recorded as Pick<DeliveryOutcome, "state" | "reason">) };
  const step = await pipeline(ports, world, gate, packetDir, signal);
  if ("waiting" in step) return { gateId: gate.gateId, state: "waiting" };
  const record = "record" in step ? step.record : step.value;
  await writeRecord(file, { ...record, at: new Date(ports.now()).toISOString() });
  return { gateId: gate.gateId, state: record.state, ...("reason" in record && { reason: record.reason }) };
}

async function pipeline(ports: VisualDeliveryPorts, world: DeliveryWorld, gate: DeliveryGate, dir: string, signal: AbortSignal): Promise<Step<DeliveryRecord>> {
  const ready = await readiness(ports, gate, dir);
  if (!("value" in ready)) return ready;
  const first = await stillAsked(world, gate);
  if (!("value" in first)) return first;
  const checkout = resolveCheckout(first.value, ports.cwdFor(first.value));
  if ("problem" in checkout) return failed("no-clone", checkout.problem);
  const built = await buildAndLint(ports, gate, dir, checkout.dir, signal);
  if (!("value" in built)) return built;
  const second = await stillAsked(world, gate);
  if (!("value" in second)) return second;
  if (ports.mode === "shadow") return { value: { state: "shadow", packetId: built.value } };
  return importRound(ports, dir, built.value, signal);
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
async function stillAsked(world: DeliveryWorld, gate: DeliveryGate): Promise<Step<string>> {
  const pr = await world.pr(gate.runId);
  if (pr === "unreadable") return { waiting: true };
  if (pr === "gone" || !pr.open || !world.pending(gate.gateId)) return { record: { state: "cancelled", reason: "gate-gone" } };
  if (pr.headSha !== gate.headSha) return { record: { state: "cancelled", reason: `new-head:${pr.headSha}` } };
  return { value: pr.repo };
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
async function importRound(ports: VisualDeliveryPorts, dir: string, packetId: string, signal: AbortSignal): Promise<Step<DeliveryRecord>> {
  const result = await run(ports, [...ports.console, "rounds", "import", dir, "--json"], signal);
  if (result.status !== 0) return failed(IMPORT_CONFLICT.test(result.detail) ? "import-conflict" : "import", result.detail);
  const report = parseJson(result.stdout, ImportResult);
  if (!report) return failed("import", "rounds import printed no import report");
  return { value: { state: "imported", packetId, roundId: report.id, created: report.created, url: report.url, lanUrl: report.lanUrl } };
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

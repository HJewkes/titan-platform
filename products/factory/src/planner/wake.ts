import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { EXIT } from "../exit-codes.js";
import type { PlannerConfig } from "./config.js";
import { buildDigest, digestPreamble, type DigestPiece } from "./digest.js";
import { combineParts, hashText, normalizeVolatile } from "./fingerprint.js";
import { readInput, type PlannerRun } from "./inputs.js";

const WakeRecordSchema = z.object({
  at: z.string(),
  outcome: z.enum(["spawned", "skipped"]),
  fingerprint: z.string().nullable(),
  parts: z.record(z.string(), z.string()),
});

type WakeRecord = z.infer<typeof WakeRecordSchema>;

interface WakePorts {
  run: PlannerRun;
  now: () => Date;
  stateDir: string;
  log: (line: string) => void;
}

const BUSY = new Set(["live", "starting", "working"]);

/** One timer wake: skip while a planner runs or nothing it reads has changed, else retire the old one and spawn. */
export async function plannerWake(config: PlannerConfig, ports: WakePorts): Promise<number> {
  const at = ports.now().toISOString();
  const state = await agentState(config, ports.run);
  if (BUSY.has(state)) {
    ports.log(`${at} skip: ${config.name} is ${state}`);
    return EXIT.OK;
  }
  const read = await readInputs(config, ports.run);
  const recordPath = join(ports.stateDir, `${config.name}.json`);
  const last = readRecord(recordPath);
  if (read.fingerprint !== null && unchanged(last, read.parts, config)) {
    ports.log(`${at} skip: inputs unchanged since ${last!.at} (${read.fingerprint.slice(0, 12)})`);
    writeRecord(recordPath, { at: last!.at, outcome: "skipped", fingerprint: read.fingerprint, parts: read.parts });
    return EXIT.OK;
  }
  if (read.error) ports.log(`${at} fingerprint unavailable (${read.error}); running`);
  if (state !== "") await ports.run(config.agentChat, ["agent", "retire", config.name]);
  const spawned = await spawn(config, ports, briefFor(config, ports.stateDir, read.pieces));
  if (spawned.code !== 0) {
    ports.log(`${at} spawn failed: exit ${spawned.code}: ${spawned.stderr.trim().split("\n")[0] ?? ""}`);
    return EXIT.FAILURE;
  }
  writeRecord(recordPath, { at, outcome: "spawned", fingerprint: read.fingerprint, parts: read.parts });
  ports.log(`${at} spawned ${config.name} on ${config.profile}${read.fingerprint ? ` (${read.fingerprint.slice(0, 12)})` : ""}`);
  return EXIT.OK;
}

interface ReadInputs {
  pieces: DigestPiece[];
  parts: Record<string, string>;
  fingerprint: string | null;
  error?: string;
}

async function readInputs(config: PlannerConfig, run: PlannerRun): Promise<ReadInputs> {
  const pieces: DigestPiece[] = [];
  try {
    for (const input of config.inputs) pieces.push({ input, text: await readInput(input, run) });
  } catch (err) {
    return { pieces, parts: {}, fingerprint: null, error: err instanceof Error ? err.message : String(err) };
  }
  const parts = Object.fromEntries(pieces.map(({ input, text }) => [input.name, hashText(normalizeVolatile(text))]));
  return { pieces, parts, fingerprint: combineParts(parts) };
}

/** After a spawn, the planner's own edits to the files it writes become the baseline instead of reading as news. */
function unchanged(last: WakeRecord | undefined, parts: Record<string, string>, config: PlannerConfig): boolean {
  if (!last?.fingerprint) return false;
  const baseline = { ...last.parts };
  if (last.outcome === "spawned") for (const input of config.inputs) if (input.selfWritten) baseline[input.name] = parts[input.name]!;
  return combineParts(baseline) === combineParts(parts);
}

async function agentState(config: PlannerConfig, run: PlannerRun): Promise<string> {
  const listed = await run(config.agentChat, ["agent", "ls"]);
  if (listed.code !== 0) return "";
  const row = listed.stdout.split("\n").map((line) => line.trim().split(/\s+/)).find((cols) => cols[0] === config.name);
  return row?.[1] ?? "";
}

function briefFor(config: PlannerConfig, stateDir: string, pieces: readonly DigestPiece[]): string {
  const brief = readFileSync(config.brief, "utf8");
  if (!config.inputs.some((input) => input.digest)) return brief;
  const path = join(stateDir, `${config.name}-digest.md`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, buildDigest(pieces, config.digestMaxTokens));
  return digestPreamble(path, config.digestMaxTokens) + brief;
}

function spawn(config: PlannerConfig, ports: WakePorts, brief: string): ReturnType<PlannerRun> {
  const args = ["agent", "spawn", config.name, config.profile, ...(config.configDir ? ["--config-dir", config.configDir] : [])];
  return ports.run(config.agentChat, [...args, "--role", config.role, "--surface", "headless", "--brief-stdin"], { input: brief, cwd: config.cwd });
}

function readRecord(path: string): WakeRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = WakeRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeRecord(path: string, record: WakeRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

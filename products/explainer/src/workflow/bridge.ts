import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadProfiles, profileFor } from "../profile-load.js";
import type { ArtifactStore } from "./artifacts.js";
import { StageFailure } from "./model-stages.js";
import { BRIDGE_STAGES, NO_USAGE, type BridgeStage, type Check, type StageOutcome } from "./records.js";

/**
 * The host file `<dataDir>/bridge.json`: the argv each bridged stage runs, kept outside the repo so no template
 * script (Python included) ships with the product. `{workdir}`, `{in.<name>}` and `{out.<name>}` in an argv or cwd
 * expand to absolute paths, and `{var.<name>}` to the stage variant's value or the block's default in `vars`.
 */
const CommandSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutS: z.number().positive().default(1800),
  /** Names a check: the command's exit code is its verdict and its last stdout line the detail. */
  check: z.string().optional(),
  /**
   * A failed gate check fails the stage, as any other failed command does. `false` makes the check reported only: a
   * non-zero exit is recorded as a failed verdict and the commands after it still run.
   */
  gate: z.boolean().default(true),
});

const OutputSchema = z.object({ path: z.string(), tree: z.boolean().default(false) });

const BridgeStageSchema = z.object({
  /** Artifact name to the path, under the workdir, it is written to before the commands run. */
  inputs: z.record(z.string(), z.string()).default({}),
  outputs: z.record(z.string(), OutputSchema),
  commands: z.array(CommandSchema).min(1),
  /** Defaults for the `{var.<name>}` tokens a stage variant may set; part of the stage key. */
  vars: z.record(z.string(), z.string()).default({}),
});

export const BridgeFileSchema = z.object({
  schema: z.literal("explainer-bridge/v1"),
  workdir: z.string(),
  stages: z.partialRecord(z.enum(BRIDGE_STAGES), BridgeStageSchema),
  /** Where the export stage links the finished video: `<dir>/<stem><suffix>` per artifact name; a companion doc is always `<dir>/companion.md`. */
  theater: z.object({ dir: z.string(), stem: z.string(), files: z.record(z.string(), z.string()) }),
});
export type BridgeFile = z.infer<typeof BridgeFileSchema>;
type BridgeCommand = z.infer<typeof CommandSchema>;

/** The fix for a host file written while a stage that runs in TypeScript now was still bridged. */
const PORTED_STAGES: Readonly<Record<string, string>> = {
  tts: 'still has a "tts" block, but tts runs in TypeScript now; delete it, and move any command it ran that is not TTS (a sample builder) to the start of "render"',
  sheets: 'still has a "sheets" block, but sheets runs in TypeScript now (the sidecar, poster and fingerprint); delete it, and drop write_video_meta.py and sheets.sh from the host',
};

const PortedStagesSchema = z.object({ stages: z.record(z.string(), z.unknown()) });

/** A bridge a profile names, kept once per host so a run in any data dir uses it without a per-run copy. */
export interface NamedBridge {
  /** The host's own explainer data dir, which holds `bridges/<name>.json`. */
  home: string;
  name: string;
}

export const bridgeFilePath = (dataDir: string, named?: NamedBridge): string =>
  named ? path.join(named.home, "bridges", `${named.name}.json`) : path.join(dataDir, "bridge.json");

export function readBridgeFile(dataDir: string, named?: NamedBridge): BridgeFile {
  const file = bridgeFilePath(dataDir, named);
  if (!existsSync(file)) throw new Error(`no bridge host file at ${file}; see the explainer README, "explainer run"`);
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  const stages = PortedStagesSchema.safeParse(raw).data?.stages ?? {};
  const ported = Object.keys(PORTED_STAGES).find((stage) => stages[stage] !== undefined);
  if (ported) throw new Error(`${file} ${PORTED_STAGES[ported]}`);
  return BridgeFileSchema.parse(raw);
}

export interface RunBridgeChoice {
  /** Where a named bridge lives; the data dir by default. */
  home?: string | undefined;
  profile?: string | undefined;
  /** Replaces the bridge's `theater.dir`. */
  theater?: string | undefined;
}

/** A run's bridge: the one its profile names, else the data dir's, linking into the theater folder the run asked for. */
export function runBridgeFile(dataDir: string, choice: RunBridgeChoice): BridgeFile {
  const name = choice.profile === undefined ? undefined : profileFor(loadProfiles(), choice.profile).bridge;
  const file = readBridgeFile(dataDir, name === undefined ? undefined : { home: choice.home ?? dataDir, name });
  return choice.theater ? { ...file, theater: { ...file.theater, dir: choice.theater } } : file;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecRequest {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/** Runs one argv; tests pass a fake that writes the outputs a real template command would. */
export type BridgeExec = (request: ExecRequest) => Promise<ExecResult>;

export const spawnExec: BridgeExec = ({ argv, cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });

function expander(workdir: string, stage: z.infer<typeof BridgeStageSchema>, vars: Readonly<Record<string, string>>): (text: string) => string {
  const at = (rel: string) => path.resolve(workdir, rel);
  return (text) =>
    text.replace(/\{(workdir|in\.[\w-]+|out\.[\w-]+|var\.[\w-]+)\}/g, (token, name: string) => {
      if (name === "workdir") return path.resolve(workdir);
      if (name.startsWith("var.")) {
        const value = vars[name.slice(4)];
        if (value === undefined) throw new Error(`bridge token ${token} names no var in the stage's "vars"`);
        return value;
      }
      const side = name.startsWith("in.") ? "in" : "out";
      const key = name.slice(side.length + 1);
      const rel = side === "in" ? stage.inputs[key] : stage.outputs[key]?.path;
      if (rel === undefined) throw new Error(`bridge token ${token} names no declared ${side === "in" ? "input" : "output"}`);
      return at(rel);
    });
}

const lastLine = (text: string): string => text.trim().split(/\r?\n/).at(-1)?.trim() ?? "";

/** Report notes are meant to be shared, so they name the workdir and home by token, not by path. */
const sharable = (line: string, workdir: string): string => line.split(path.resolve(workdir)).join("{workdir}").split(homedir()).join("~");

export interface BridgeRun {
  stage: BridgeStage;
  artifacts: Readonly<Record<string, string>>;
  runId: string;
  store: ArtifactStore;
  file: BridgeFile;
  exec: BridgeExec;
  /** Each command's full stdout and stderr land here, one file per command. */
  logDir: string;
  /** The `{var.<name>}` values: the block's defaults with the stage variant's params over them. */
  vars?: Readonly<Record<string, string>>;
}

async function runCommand(run: BridgeRun, command: BridgeCommand, n: number, expand: (text: string) => string): Promise<{ note: string; check?: Check }> {
  const argv = command.argv.map(expand);
  const started = Date.now();
  const result = await run.exec({ argv, cwd: expand(command.cwd ?? "{workdir}"), env: command.env ?? {}, timeoutMs: command.timeoutS * 1000 });
  mkdirSync(run.logDir, { recursive: true });
  writeFileSync(path.join(run.logDir, `${run.stage}-${n}.log`), `$ ${argv.join(" ")}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`);
  const line = sharable(lastLine(result.stdout), run.file.workdir);
  // The script an interpreter runs names the command better than the interpreter does.
  const name = path.basename(argv.find((arg) => /\.[cm]?[jt]s$|\.sh$|\.py$/.test(arg)) ?? argv[0]!);
  const pass = result.code === 0;
  const check = command.check ? { check: { name: command.check, gate: command.gate, pass, detail: line.slice(0, 160) } } : {};
  if (!pass && (command.gate || !command.check)) {
    throw new CommandFailure(`bridge ${run.stage}: command ${n} (${name}) exited ${result.code}: ${sharable(lastLine(result.stderr), run.file.workdir) || line}`, check.check);
  }
  const note = `${name} ${((Date.now() - started) / 1000).toFixed(1)} s${line ? `: ${line.slice(0, 160)}` : ""}`;
  return { note, ...check };
}

class CommandFailure extends Error {
  constructor(message: string, readonly check: Check | undefined) {
    super(message);
  }
}

/** Writes the declared inputs, runs the commands in order, then stores the declared outputs. Any non-zero exit fails the stage. */
export async function runBridgeStage(run: BridgeRun): Promise<StageOutcome> {
  const stage = run.file.stages[run.stage];
  if (!stage) throw new Error(`bridge host file has no "${run.stage}" stage`);
  const expand = expander(run.file.workdir, stage, run.vars ?? stage.vars);
  for (const [name, rel] of Object.entries(stage.inputs)) {
    const sha = run.artifacts[name];
    if (sha === undefined) throw new Error(`stage ${run.stage} needs artifact "${name}", which no earlier stage produced`);
    run.store.materialise(sha, path.resolve(run.file.workdir, rel));
  }
  const notes: string[] = [];
  const checks: Check[] = [];
  for (const [i, command] of stage.commands.entries()) {
    try {
      const { note, check } = await runCommand(run, command, i + 1, expand);
      notes.push(note);
      if (check) checks.push(check);
    } catch (error) {
      if (!(error instanceof CommandFailure)) throw error;
      throw new StageFailure(error.message, NO_USAGE, 0, error.check ? [...checks, error.check] : checks);
    }
  }
  const from = { runId: run.runId, stage: run.stage };
  const outputs = Object.fromEntries(Object.entries(stage.outputs).map(([name, out]) => {
    const at = path.resolve(run.file.workdir, out.path);
    return [name, out.tree ? run.store.putTree(at, name, from) : run.store.putFile(at, name, from)];
  }));
  return { outputs, checks, notes };
}

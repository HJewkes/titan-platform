import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ArtifactStore } from "./artifacts.js";
import { BRIDGE_STAGES, type BridgeStage, type Check, type StageOutcome } from "./records.js";

/**
 * The host file `<dataDir>/bridge.json`: the argv each bridged stage runs, kept outside the repo so no template
 * script (Python included) ships with the product. `{workdir}`, `{in.<name>}` and `{out.<name>}` in an argv or cwd
 * expand to absolute paths.
 */
const CommandSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutS: z.number().positive().default(1800),
  /** Names a check: the command's exit code is its verdict and its last stdout line the detail. */
  check: z.string().optional(),
});

const OutputSchema = z.object({ path: z.string(), tree: z.boolean().default(false) });

const BridgeStageSchema = z.object({
  /** Artifact name to the path, under the workdir, it is written to before the commands run. */
  inputs: z.record(z.string(), z.string()).default({}),
  outputs: z.record(z.string(), OutputSchema),
  commands: z.array(CommandSchema).min(1),
});

export const BridgeFileSchema = z.object({
  schema: z.literal("explainer-bridge/v1"),
  workdir: z.string(),
  stages: z.partialRecord(z.enum(BRIDGE_STAGES), BridgeStageSchema),
  /** Where the export stage links the finished video: `<dir>/<stem><suffix>` per artifact name. */
  theater: z.object({ dir: z.string(), stem: z.string(), files: z.record(z.string(), z.string()) }),
});
export type BridgeFile = z.infer<typeof BridgeFileSchema>;
type BridgeCommand = z.infer<typeof CommandSchema>;

export const bridgeFilePath = (dataDir: string): string => path.join(dataDir, "bridge.json");

export function readBridgeFile(dataDir: string): BridgeFile {
  const file = bridgeFilePath(dataDir);
  if (!existsSync(file)) throw new Error(`no bridge host file at ${file}; see the explainer README, "explainer run"`);
  return BridgeFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
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

function expander(workdir: string, stage: z.infer<typeof BridgeStageSchema>): (text: string) => string {
  const at = (rel: string) => path.resolve(workdir, rel);
  return (text) =>
    text.replace(/\{(workdir|in\.[\w-]+|out\.[\w-]+)\}/g, (token, name: string) => {
      if (name === "workdir") return path.resolve(workdir);
      const [side, key] = name.split(".") as ["in" | "out", string];
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
  if (result.code !== 0) throw new Error(`bridge ${run.stage}: command ${n} (${name}) exited ${result.code}: ${sharable(lastLine(result.stderr), run.file.workdir) || line}`);
  const note = `${name} ${((Date.now() - started) / 1000).toFixed(1)} s${line ? `: ${line.slice(0, 160)}` : ""}`;
  return { note, ...(command.check ? { check: { name: command.check, pass: true, detail: line.slice(0, 160) } } : {}) };
}

/** Writes the declared inputs, runs the commands in order, then stores the declared outputs. Any non-zero exit fails the stage. */
export async function runBridgeStage(run: BridgeRun): Promise<StageOutcome> {
  const stage = run.file.stages[run.stage];
  if (!stage) throw new Error(`bridge host file has no "${run.stage}" stage`);
  const expand = expander(run.file.workdir, stage);
  for (const [name, rel] of Object.entries(stage.inputs)) {
    const sha = run.artifacts[name];
    if (sha === undefined) throw new Error(`stage ${run.stage} needs artifact "${name}", which no earlier stage produced`);
    run.store.materialise(sha, path.resolve(run.file.workdir, rel));
  }
  const notes: string[] = [];
  const checks: Check[] = [];
  for (const [i, command] of stage.commands.entries()) {
    const { note, check } = await runCommand(run, command, i + 1, expand);
    notes.push(note);
    if (check) checks.push(check);
  }
  const from = { runId: run.runId, stage: run.stage };
  const outputs = Object.fromEntries(Object.entries(stage.outputs).map(([name, out]) => {
    const at = path.resolve(run.file.workdir, out.path);
    return [name, out.tree ? run.store.putTree(at, name, from) : run.store.putFile(at, name, from)];
  }));
  return { outputs, checks, notes };
}

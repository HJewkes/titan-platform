import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSupported } from "./capabilities.js";
import { withDeadline } from "./deadline.js";
import { TtsFailedError, TtsUnavailableError } from "./errors.js";
import { isRecord } from "./guards.js";
import { decodeEngineWav, toSynthesis } from "./synthesis.js";
import type {
  PhonemeAlphabet,
  Synthesis,
  SynthesizeOptions,
  TtsCapabilities,
  TtsInput,
  TtsProvider,
  TtsToken,
} from "./types.js";

/** `stdout-wav`: the command writes RIFF bytes to stdout. `json`: it writes one JSON object (see the README). */
export type CommandOutput = "stdout-wav" | "json";

export interface CommandTtsOptions {
  id: string;
  /** The program and its arguments, run without a shell. `["ssh", "gpu-box", "tts-cli"]` reaches a remote engine. */
  argv: readonly string[];
  capabilities: TtsCapabilities;
  output?: CommandOutput;
  /** Merged over the parent's environment. */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  timeoutMs?: number;
  /** Exit codes that mean "engine not reachable" rather than "engine failed": EX_UNAVAILABLE, shell not-found, ssh. */
  unavailableExitCodes?: readonly number[];
}

/** The JSON document written to the command's stdin, then stdin is closed. */
export interface CommandRequest {
  version: 1;
  voice: string;
  text?: string;
  tokens?: readonly TtsToken[];
  alphabet?: PhonemeAlphabet;
  speed?: number;
  language?: string;
  /** In `json` mode, a fresh path the command may write its WAV to and name as `wav`. */
  out?: string;
}

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

const STDERR_TAIL = 2_000;
const DEFAULT_UNAVAILABLE = [69, 127, 255];

export function commandRequest(input: TtsInput, voice: string, options: SynthesizeOptions, out?: string): CommandRequest {
  return {
    version: 1,
    voice,
    ...("tokens" in input ? { tokens: input.tokens, alphabet: input.alphabet } : { text: input.text }),
    ...(options.speed !== undefined ? { speed: options.speed } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(out ? { out } : {}),
  };
}

/** Kills the whole process group, so a wrapper (`sh -c`, a Python launcher) cannot leave its engine running. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function run(opts: CommandTtsOptions, request: CommandRequest, signal: AbortSignal): Promise<RunResult> {
  const [command, ...args] = opts.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command ?? "", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    const onAbort = (): void => killTree(child.pid);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL)));
    // A command that exits without reading its request closes the pipe; its exit code says what happened.
    child.stdin.on("error", () => undefined);
    child.on("error", (cause) => reject(new TtsUnavailableError(opts.id, `cannot start ${command}: ${cause.message}`, { cause })));
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: stderr.trim() });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function checkExit(opts: CommandTtsOptions, result: RunResult): void {
  if (result.code === 0) return;
  const detail = `${opts.argv[0]} exited ${result.code ?? "on a signal"}${result.stderr ? `: ${result.stderr}` : ""}`;
  if ((opts.unavailableExitCodes ?? DEFAULT_UNAVAILABLE).includes(result.code ?? -1)) throw new TtsUnavailableError(opts.id, detail);
  throw new TtsFailedError(opts.id, detail);
}

async function parseJsonOutput(opts: CommandTtsOptions, stdout: Buffer): Promise<Synthesis> {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.toString("utf8"));
  } catch (cause) {
    throw new TtsFailedError(opts.id, "stdout is not JSON", { cause });
  }
  if (!isRecord(doc)) throw new TtsFailedError(opts.id, "stdout is not one JSON object");
  let bytes: Uint8Array;
  if (typeof doc.audioBase64 === "string") bytes = Buffer.from(doc.audioBase64, "base64");
  else if (typeof doc.wav === "string") bytes = await readFile(doc.wav);
  else throw new TtsFailedError(opts.id, "JSON output names neither wav nor audioBase64");
  return toSynthesis(opts.id, opts.capabilities, decodeEngineWav(opts.id, bytes), doc);
}

async function synthesizeOnce(opts: CommandTtsOptions, request: CommandRequest, signal: AbortSignal): Promise<Synthesis> {
  const result = await run(opts, request, signal);
  checkExit(opts, result);
  if (opts.output === "stdout-wav") return toSynthesis(opts.id, opts.capabilities, decodeEngineWav(opts.id, result.stdout));
  return parseJsonOutput(opts, result.stdout);
}

/** Any external program that speaks the stdio contract in the README: a local engine, or one behind ssh. */
export function commandTts(opts: CommandTtsOptions): TtsProvider {
  if (opts.argv.length === 0) throw new TypeError(`${opts.id}: commandTts needs a non-empty argv`);
  const synthesize = async (input: TtsInput, voice: string, options: SynthesizeOptions = {}): Promise<Synthesis> => {
    assertSupported(opts.id, opts.capabilities, input, voice, options);
    const dir = opts.output === "stdout-wav" ? undefined : await mkdtemp(join(tmpdir(), "speech-tts-"));
    const request = commandRequest(input, voice, options, dir && join(dir, "out.wav"));
    try {
      return await withDeadline(opts.id, options.timeoutMs ?? opts.timeoutMs ?? 120_000, options.signal, (signal) =>
        synthesizeOnce(opts, request, signal),
      );
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
  return { id: opts.id, capabilities: opts.capabilities, synthesize };
}

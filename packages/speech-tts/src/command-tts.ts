import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { FileRefused, readRegularFile } from "./bounded-read.js";
import { assertSupported } from "./capabilities.js";
import { withDeadline } from "./deadline.js";
import { TtsFailedError, TtsUnavailableError } from "./errors.js";
import { errorMessage } from "./guards.js";
import { DEFAULT_MAX_OUTPUT_BYTES, errorText } from "./output-limits.js";
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
  /** Added to the child's minimal environment (see `INHERITED_ENV`); nothing else of the parent's is passed. */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  timeoutMs?: number;
  /** Past this many bytes of stdout, or of the named WAV file, the command is killed. Default 64 MB. */
  maxOutputBytes?: number;
  /** Values never quoted in an error, such as tokens passed in `env`. */
  secrets?: readonly string[];
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
  /** In `json` mode, a fresh directory for this call. A `wav` in the answer is a bare filename in it. */
  outDir?: string;
  /** In `json` mode, a suggested file inside `outDir`. */
  out?: string;
}

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** The parent variables a child sees. Anything else, such as an API key, must be listed in `env`. */
export const INHERITED_ENV = ["PATH", "HOME", "LANG", "TMPDIR"] as const;

/** Raw stderr kept for the error message; more than is shown, so redaction runs before the cut. */
const STDERR_RAW = 16_000;
const DEFAULT_UNAVAILABLE = [69, 127, 255];

function commandRequest(input: TtsInput, voice: string, options: SynthesizeOptions, outDir?: string): CommandRequest {
  return {
    version: 1,
    voice,
    ...("tokens" in input ? { tokens: input.tokens, alphabet: input.alphabet } : { text: input.text }),
    ...(options.speed !== undefined ? { speed: options.speed } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(outDir ? { outDir, out: join(outDir, "out.wav") } : {}),
  };
}

function childEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const inherited = INHERITED_ENV.flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return { ...Object.fromEntries(inherited), ...extra };
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

/** Counts as it reads, so an endless stream trips the limit instead of filling memory. */
function collect(stream: Readable, limit: number, onOverflow: () => void): () => Buffer {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on("data", (chunk: Buffer) => {
    if (size > limit) return;
    size += chunk.length;
    if (size <= limit) return void chunks.push(chunk);
    chunks.length = 0;
    onOverflow();
  });
  return () => Buffer.concat(chunks);
}

function run(opts: CommandTtsOptions, request: CommandRequest, signal: AbortSignal): Promise<RunResult> {
  const [command, ...args] = opts.argv;
  const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(command ?? "", args, {
      cwd: opts.cwd,
      env: childEnv(opts.env),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = collect(child.stdout, limit, () => {
      killTree(child.pid);
      reject(new TtsFailedError(opts.id, `stdout passed maxOutputBytes (${limit}); the command was killed`));
    });
    let stderr = "";
    const onAbort = (): void => killTree(child.pid);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-STDERR_RAW)));
    // A command that exits without reading its request closes the pipe; its exit code says what happened.
    child.stdin.on("error", () => undefined);
    child.on("error", (cause) => reject(new TtsUnavailableError(opts.id, `cannot start ${command}: ${cause.message}`, { cause })));
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout: stdout(), stderr });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function checkExit(opts: CommandTtsOptions, result: RunResult): void {
  if (result.code === 0) return;
  const stderr = errorText(result.stderr, opts.secrets, "tail");
  const detail = `${opts.argv[0]} exited ${result.code ?? "on a signal"}${stderr ? `: ${stderr}` : ""}`;
  if ((opts.unavailableExitCodes ?? DEFAULT_UNAVAILABLE).includes(result.code ?? -1)) throw new TtsUnavailableError(opts.id, detail);
  throw new TtsFailedError(opts.id, detail);
}

const escapes = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/**
 * Reads the named WAV only from inside this call's `outDir`, after resolving symlinks. The read itself goes through
 * one descriptor opened without following links, so a swap after the path checks cannot redirect it.
 */
async function readConfinedWav(opts: CommandTtsOptions, dir: string, wav: string): Promise<Uint8Array> {
  const fail = (why: string): never => {
    throw new TtsFailedError(opts.id, `wav "${wav}" ${why}`);
  };
  if (isAbsolute(wav)) fail("must be a path relative to outDir, not absolute");
  if (/[\\/]/.test(wav) || wav === "..") fail("must be a bare filename in outDir, with no directory part");
  if (escapes(dir, resolve(dir, wav))) fail("escapes outDir");
  const realDir = await realpath(dir);
  const realFile = await realpath(resolve(dir, wav)).catch(() => fail("does not exist in outDir"));
  if (escapes(realDir, realFile)) fail("links outside outDir");
  try {
    return await readRegularFile(realFile, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  } catch (error) {
    if (error instanceof FileRefused) return fail(error.message);
    throw error;
  }
}

async function parseJsonOutput(opts: CommandTtsOptions, stdout: Buffer, dir: string): Promise<Synthesis> {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.toString("utf8"));
  } catch (cause) {
    throw new TtsFailedError(opts.id, "stdout is not JSON", { cause });
  }
  if (!isRecord(doc)) throw new TtsFailedError(opts.id, "stdout is not one JSON object");
  let bytes: Uint8Array;
  if (typeof doc.audioBase64 === "string") bytes = Buffer.from(doc.audioBase64, "base64");
  else if (typeof doc.wav === "string") bytes = await readConfinedWav(opts, dir, doc.wav);
  else throw new TtsFailedError(opts.id, "JSON output names neither wav nor audioBase64");
  return toSynthesis(opts.id, opts.capabilities, decodeEngineWav(opts.id, bytes), doc);
}

/** Cleanup runs in a `finally`; a failure here must not replace the synthesis result or its real error. */
async function removeScratch(id: string, dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (cause) {
    process.emitWarning(`${id}: could not remove scratch directory ${dir}: ${errorMessage(cause)}`, "SpeechTtsWarning");
  }
}

async function synthesizeOnce(opts: CommandTtsOptions, request: CommandRequest, signal: AbortSignal): Promise<Synthesis> {
  signal.throwIfAborted();
  const result = await run(opts, request, signal);
  checkExit(opts, result);
  if (!request.outDir) return toSynthesis(opts.id, opts.capabilities, decodeEngineWav(opts.id, result.stdout));
  return parseJsonOutput(opts, result.stdout, request.outDir);
}

/** Any external program that speaks the stdio contract in the README: a local engine, or one behind ssh. */
export function commandTts(opts: CommandTtsOptions): TtsProvider {
  if (opts.argv.length === 0) throw new TypeError(`${opts.id}: commandTts needs a non-empty argv`);
  const synthesize = async (input: TtsInput, voice: string, options: SynthesizeOptions = {}): Promise<Synthesis> => {
    assertSupported(opts.id, opts.capabilities, input, voice, options);
    const dir = opts.output === "stdout-wav" ? undefined : await mkdtemp(join(tmpdir(), "speech-tts-"));
    const request = commandRequest(input, voice, options, dir);
    try {
      return await withDeadline(opts.id, options.timeoutMs ?? opts.timeoutMs ?? 120_000, options.signal, (signal) =>
        synthesizeOnce(opts, request, signal),
      );
    } finally {
      if (dir) await removeScratch(opts.id, dir);
    }
  };
  return { id: opts.id, capabilities: opts.capabilities, synthesize };
}

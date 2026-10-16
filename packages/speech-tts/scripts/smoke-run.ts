import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeWav,
  encodeWav,
  resolveSpeechRuntime,
  runtimeOptions,
  speechDeviceEnvName,
  SpeechRuntimeError,
  type Audio,
  type SpeechEnv,
  type SpeechRuntime,
} from "@titan-design/speech-tts";
import type { EngineRuntime, ModelInfo, SmokeEngines, SmokePhones, SmokeStt, SmokeTts } from "./smoke-engines.ts";
import { realTimeFactor, SMOKE_STAGES, smokeReportSchema, type SmokeReport, type SmokeStage, type StageResult } from "./smoke-report.ts";

// Constructed for spike E8, not taken from any text: short words and common phonemes, about six seconds of speech.
const SENTENCE = "The quick lamp on the green table hums softly while seven small boats drift past the quiet harbor.";
const USAGE = "usage: smoke:speech [--suite [all|tts,stt,phones]] [--device cpu|cuda] [--profile file] [--wav file] [--out file] [--voice id]";

export interface SmokeDeps {
  engines: SmokeEngines;
  env: SpeechEnv;
  /** Milliseconds; injected so a test controls every wall time the report holds. */
  now: () => number;
  log: (line: string) => void;
}

interface SmokeArgs {
  suite: SmokeStage[];
  device?: string;
  profile?: string;
  wav?: string;
  out?: string;
  voice: string;
}

class UsageError extends Error {}

function parseSuite(text: string): SmokeStage[] {
  const names = text === "all" ? SMOKE_STAGES : text.split(",");
  const bad = names.filter((n) => !SMOKE_STAGES.some((s) => s === n));
  if (bad.length > 0) throw new UsageError(`unknown suite stage ${bad.join(",")}; use all or a list of ${SMOKE_STAGES.join(",")}`);
  return SMOKE_STAGES.filter((s) => names.includes(s));
}

function parseArgs(argv: readonly string[]): SmokeArgs {
  const args: SmokeArgs = { suite: ["tts"], voice: "af_heart" };
  const files = { "--profile": "profile", "--wav": "wav", "--out": "out" } as const;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    const value = (): string => argv[++i] ?? fail(`${flag} needs a value`);
    if (flag === "--suite") args.suite = parseSuite(argv[i + 1] === undefined || argv[i + 1]?.startsWith("--") ? "all" : value());
    else if (flag === "--device") args.device = value();
    else if (flag === "--voice") args.voice = value();
    else if (flag === "--profile" || flag === "--wav" || flag === "--out") args[files[flag]] = path.resolve(value());
    else fail(`unknown flag ${flag}\n${USAGE}`);
  }
  return args;
}

function fail(message: string): never {
  throw new UsageError(message);
}

// --device sets every per-component variable, so the flag beats the environment and the profile alike, and
// detectSpeechRuntime still rejects a device this host cannot run.
function resolveRuntime(args: SmokeArgs, env: SpeechEnv): Promise<SpeechRuntime> {
  const forced = args.device === undefined ? {} : Object.fromEntries(SMOKE_STAGES.map((s) => [speechDeviceEnvName(s), args.device]));
  return resolveSpeechRuntime({ env: { ...env, ...forced }, ...(args.profile ? { profilePath: args.profile } : {}) });
}

interface Timed<T> {
  first: T;
  coldMs: number;
  warmMs: number;
}

async function timedTwice<T>(now: () => number, run: () => Promise<T>): Promise<Timed<T>> {
  const t0 = now();
  const first = await run();
  const t1 = now();
  await run();
  return { first, coldMs: t1 - t0, warmMs: now() - t1 };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const maxRssMb = (): number => Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10;
const audioSeconds = (audio: Audio): number => audio.samples.length / audio.sampleRate;

// Load is the cold call minus the warm call, as the packages' own smoke tests measure it.
function timing(timed: Timed<unknown>, audioS: number) {
  const wallS = timed.warmMs / 1000;
  return {
    loadS: round3(Math.max(timed.coldMs - timed.warmMs, 0) / 1000),
    inferS: round3(wallS),
    audioS: round3(audioS),
    rtf: realTimeFactor(audioS, wallS),
    maxRssMbAfter: maxRssMb(),
  };
}

function wordErrorRate(reference: string, hypothesis: string): number {
  const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const ref = words(reference);
  const hyp = words(hypothesis);
  let row = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const next = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const swap = (row[j - 1] ?? 0) + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, swap));
    }
    row = next;
  }
  return round3((row[hyp.length] ?? 0) / ref.length);
}

interface StageContext {
  args: SmokeArgs;
  deps: SmokeDeps;
  runtime: SpeechRuntime;
  wavPath: string;
  disposers: (() => Promise<void>)[];
}

const readWav = (wavPath: string): Audio => decodeWav(new Uint8Array(readFileSync(wavPath)));

type Measured = Omit<Extract<StageResult, { ok: true }>, "ok" | keyof ModelInfo | "device">;

async function measureTts(ctx: StageContext, tts: SmokeTts): Promise<Measured> {
  const timed = await timedTwice(ctx.deps.now, () => tts.synthesize(SENTENCE, ctx.args.voice));
  writeFileSync(ctx.wavPath, encodeWav(timed.first));
  return { ...timing(timed, audioSeconds(timed.first)), wavPath: ctx.wavPath };
}

async function measureStt(ctx: StageContext, stt: SmokeStt): Promise<Measured> {
  const audio = readWav(ctx.wavPath);
  const timed = await timedTwice(ctx.deps.now, () => stt.transcribe(audio));
  const transcript = timed.first;
  const words = transcript.split(/\s+/).filter(Boolean).length;
  return { ...timing(timed, audioSeconds(audio)), words, transcript, wer: wordErrorRate(SENTENCE, transcript) };
}

async function measurePhones(ctx: StageContext, rec: SmokePhones): Promise<Measured> {
  const audio = readWav(ctx.wavPath);
  const timed = await timedTwice(ctx.deps.now, () => rec.recognize(audio));
  return { ...timing(timed, audioSeconds(audio)), ...timed.first };
}

interface OpenStage {
  info: ModelInfo;
  measure: () => Promise<Measured>;
}

function openStage(ctx: StageContext, name: SmokeStage, runtime: EngineRuntime): OpenStage {
  const { engines } = ctx.deps;
  if (name === "tts") {
    const tts = engines.tts(runtime);
    return { info: tts, measure: () => measureTts(ctx, tts) };
  }
  const engine = name === "stt" ? engines.stt(runtime) : engines.phones(runtime);
  ctx.disposers.push(() => engine.dispose());
  return { info: engine, measure: () => ("transcribe" in engine ? measureStt(ctx, engine) : measurePhones(ctx, engine)) };
}

const modelInfo = ({ model, revision, dtype }: ModelInfo): ModelInfo => ({ model, revision, dtype });
const errorText = (err: unknown): string => String(err instanceof Error ? (err.stack ?? err.message) : err).split("\n").slice(0, 4).join(" | ");

// The model is named on a failed stage too, so a load failure says which download or session broke.
async function runStage(ctx: StageContext, name: SmokeStage): Promise<StageResult> {
  const runtime = runtimeOptions(ctx.runtime, name);
  let info: ModelInfo = { model: "unknown", revision: "unknown", dtype: "unknown" };
  try {
    const stage = openStage(ctx, name, runtime);
    info = modelInfo(stage.info);
    return { ok: true, device: runtime.device, ...info, ...(await stage.measure()) };
  } catch (err) {
    return { ok: false, device: runtime.device, ...info, error: errorText(err) };
  }
}

// tts writes the WAV; stt and phones read that file back rather than the in-memory samples, as spike E8 did.
async function runStages(ctx: StageContext): Promise<SmokeReport["stages"]> {
  const stages: SmokeReport["stages"] = {};
  for (const name of ctx.args.suite) {
    const result = await runStage(ctx, name);
    stages[name] = result;
    if (name === "tts" && !result.ok) break;
  }
  await Promise.allSettled(ctx.disposers.map((dispose) => dispose()));
  return stages;
}

function wavPathFor(args: SmokeArgs): string {
  if (args.suite.includes("tts")) return args.wav ?? path.join(os.tmpdir(), `titan-speech-smoke-${process.pid}.wav`);
  if (!args.wav || !existsSync(args.wav)) fail("stages stt and phones need an existing --wav file when tts is not in the suite");
  return args.wav;
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const entryPath = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? dirBytes(entryPath) : statSync(entryPath).size);
  }, 0);
}

const PACKAGES = ["@titan-design/speech-tts", "@titan-design/speech-stt", "@titan-design/speech-g2p", "@huggingface/transformers", "kokoro-js"];

// Walks up from each entry point, because a package's exports map may not expose its package.json. The workspace
// packages export only an import condition, so require.resolve cannot find them.
function packageVersion(name: string): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.resolve(name)));
    for (; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const file = path.join(dir, "package.json");
      const pkg: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
      if (pkg && typeof pkg === "object" && "name" in pkg && pkg.name === name && "version" in pkg) return String(pkg.version);
    }
  } catch {
    // An optional peer that is not installed reads as missing.
  }
  return "missing";
}

function hostInfo(): SmokeReport["host"] {
  return {
    os: process.platform,
    release: os.release(),
    arch: process.arch,
    cpus: os.availableParallelism(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    memGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  };
}

async function buildReport(args: SmokeArgs, deps: SmokeDeps): Promise<SmokeReport> {
  const runtime = await resolveRuntime(args, deps.env);
  const startedAt = new Date().toISOString();
  const started = deps.now();
  const stages = await runStages({ args, deps, runtime, wavPath: wavPathFor(args), disposers: [] });
  return smokeReportSchema.parse({
    schemaVersion: 1,
    ok: Object.values(stages).every((s) => s.ok),
    suite: args.suite,
    sentence: SENTENCE,
    voice: args.voice,
    profile: args.profile ?? deps.env.TITAN_SPEECH_PROFILE ?? null,
    startedAt,
    host: hostInfo(),
    node: process.version,
    packages: Object.fromEntries(PACKAGES.map((name) => [name, packageVersion(name)])),
    cache: { dir: runtime.cacheDir, source: runtime.source.cacheDir, usedBytes: dirBytes(runtime.cacheDir) },
    stages,
    maxRssMb: maxRssMb(),
    wallS: round3((deps.now() - started) / 1000),
  });
}

/** Runs the smoke and writes its JSON report. Exit codes: 0 every stage passed, 1 a stage failed, 2 bad usage or device. */
export async function runSmoke(argv: readonly string[], deps: SmokeDeps): Promise<number> {
  try {
    const args = parseArgs(argv);
    const report = await buildReport(args, deps);
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out) writeFileSync(args.out, text);
    else process.stdout.write(text);
    deps.log(`smoke: ${report.ok ? "ok" : "FAILED"} suite=${args.suite.join(",")} wall=${report.wallS}s maxRss=${report.maxRssMb}MB`);
    return report.ok ? 0 : 1;
  } catch (err) {
    if (!(err instanceof UsageError || err instanceof SpeechRuntimeError)) throw err;
    deps.log(`smoke: error: ${err.message}`);
    return 2;
  }
}

/**
 * The vet cycle: precheck a line's declared readings, synthesize it, check every take in full, retake while a
 * fault remains, keep the best take, and say what its remaining faults ask of the caller. Every model arrives
 * as a provider, so nothing here loads one. The caller passes normalized text: `vet` does not normalize.
 */
import { misakiToIpa, ttsTokens, type G2p, type G2pToken } from "@titan-design/speech-g2p";
import type { SttProvider, Transcript, WordDiff } from "@titan-design/speech-stt";
import type { Synthesis, SynthesizeOptions, TtsInput, TtsProvider } from "@titan-design/speech-tts";
import { applyLexicon } from "./apply-lexicon.js";
import { defectOptionsFor, type DefectOptions } from "./defects.js";
import { checkReadings, englishHeteronyms, type HeteronymTable, type ReadingFinding } from "./heteronyms.js";
import type { Lexicon } from "./lexicon.js";
import { g2pText, plainText } from "./markup.js";
import type { Hallucination, PhoneRecognizer, TailArtifact, WordVerdict } from "./phone-verdicts.js";
import type { PhoneG2p } from "./phones.js";
import type { HeardReading, MisakiToIpa } from "./reading-phones.js";
import { DEFAULT_RETRIES } from "./retake.js";
import { checkTake, type CheckContext, type TakeCheck } from "./vet-check.js";
import { betterTake, isFutile, outcome, type Decision, type DefectFinding, type Fault } from "./vet-decide.js";

export interface VetDeps {
  tts: TtsProvider;
  voice: string;
  stt: SttProvider;
  /** Required when `tts` takes misaki phonemes; with a text voice it only gives the heard-reading check its spans. */
  g2p?: Pick<G2p, "tokens" | "version">;
  recognizer?: PhoneRecognizer;
  /** Required with a recognizer: whether misaki may drive verdicts is the caller's call, so there is no default. */
  phoneG2p?: PhoneG2p;
  confirmStt?: SttProvider;
  lexicon?: Lexicon;
  /** Defaults to speech-g2p's `misakiToIpa`. */
  toIpa?: MisakiToIpa;
}

export interface VetPolicy {
  /** Retakes after the first take; defaults to `DEFAULT_RETRIES`. */
  maxRetakes?: number;
  /** Defaults to `KEEP_TAKE_MARGIN`. */
  margin?: number;
  /** `fail` stops on an undeclared heteronym before any audio is made. Default `warn`. */
  undeclaredHeteronym?: "warn" | "fail";
  table?: HeteronymTable;
  synthesize?: Pick<SynthesizeOptions, "speed" | "language" | "timeoutMs" | "signal">;
}

export interface VetTake {
  /** One-based. */
  attempt: number;
  synthesis: Synthesis;
  transcript: Transcript;
}

/** One take's checks, JSON-safe. */
interface TakeReport {
  attempt: number;
  transcript: string;
  textDiff: WordDiff;
  defects: DefectFinding[];
  phones?: string;
  hallucinations: Hallucination[];
  tail: TailArtifact | null;
  heard: HeardReading[];
  /** Undeclared heteronyms the audio contradicts: warnings, not faults, while owner decision D-T11-3 is open. */
  warnings: HeardReading[];
  faults: Fault[];
  dismissed: WordVerdict[];
  kept: boolean;
}

/** `unverifiable`: the voice takes text, so the G2P reading checked is not the one it speaks. */
interface Precheck {
  status: "verified" | "unverifiable" | "stopped";
  findings: ReadingFinding[];
}

/** JSON-safe: no audio. */
export interface VetReport {
  tts: string;
  voice: string;
  g2pVersion?: string;
  tableVersion: number;
  precheck: Precheck;
  defectOptions: { stt: DefectOptions; confirmStt?: DefectOptions };
  takes: TakeReport[];
  keptAttempt?: number;
  /** `futile`: a take heard the same as the one before it, so the voice is deterministic and retakes cannot help. */
  stopReason: "clean" | "futile" | "budget" | "precheck";
}

export type VetResult =
  | (Decision & { take: VetTake; report: VetReport })
  | { status: "stopped"; findings: ReadingFinding[]; report: VetReport };

interface Taken {
  take: VetTake;
  check: TakeCheck;
}

interface Run {
  input: TtsInput;
  ctx: CheckContext;
  deps: VetDeps;
  policy: VetPolicy;
}

const takesMisaki = (tts: TtsProvider): boolean => tts.capabilities.phonemeInput.includes("misaki");

/** Runs the vet cycle over `spoken`, a normalized line with optional `[w](=reading)` and `[w](/phonemes/)` markup. */
export async function vet(spoken: string, deps: VetDeps, policy: VetPolicy = {}): Promise<VetResult> {
  assertInputs(deps, policy);
  const misaki = takesMisaki(deps.tts);
  const voiceSpoken = misaki && deps.lexicon ? applyLexicon(spoken, deps.lexicon, "misaki") : spoken;
  const { tokens, precheck, blocking } = runPrecheck(voiceSpoken, deps, policy);
  const base = { ...reportBase(deps, policy), precheck };
  if (precheck.status === "stopped") return { status: "stopped", findings: blocking, report: { ...base, takes: [], stopReason: "precheck" } };
  const ctx = checkContext(spoken, voiceSpoken, tokens, deps, policy);
  const { taken, best, stopReason } = await runTakes({ input: voiceInput(spoken, tokens, deps), ctx, deps, policy });
  const takes = taken.map((t) => takeReport(t, t === best));
  return { ...outcome(best.check, misaki), take: best.take, report: { ...base, takes, keptAttempt: best.take.attempt, stopReason } };
}

function assertInputs(deps: VetDeps, policy: VetPolicy): void {
  if (takesMisaki(deps.tts) && !deps.g2p) throw new TypeError("vet: a voice that takes misaki phonemes needs a g2p");
  if (deps.recognizer && !deps.phoneG2p) throw new TypeError("vet: a recognizer needs a phoneG2p; there is no default");
  const maxRetakes = policy.maxRetakes ?? DEFAULT_RETRIES;
  if (!Number.isInteger(maxRetakes) || maxRetakes < 0) throw new RangeError(`vet: maxRetakes must be a whole number >= 0, got ${maxRetakes}`);
}

/**
 * The line's G2P tokens and the check of its declared readings, before any audio. Only a misaki voice speaks
 * those tokens, so only there can the check stop the cycle; a text voice reports it `unverifiable`.
 */
function runPrecheck(voiceSpoken: string, deps: VetDeps, policy: VetPolicy): { tokens?: G2pToken[]; precheck: Precheck; blocking: ReadingFinding[] } {
  const tokens = deps.g2p?.tokens(g2pText(voiceSpoken));
  if (!tokens) return { precheck: { status: "unverifiable", findings: [] }, blocking: [] };
  const findings = checkReadings(voiceSpoken, tokens, policy.table ?? englishHeteronyms);
  if (!takesMisaki(deps.tts)) return { tokens, precheck: { status: "unverifiable", findings }, blocking: [] };
  const blocking = findings.filter((f) => f.status === "fail" || (f.status === "warn" && policy.undeclaredHeteronym === "fail"));
  return { tokens, precheck: { status: blocking.length ? "stopped" : "verified", findings }, blocking };
}

/** A misaki voice gets the checked tokens, so it cannot re-run G2P and read the line differently. */
function voiceInput(spoken: string, tokens: readonly G2pToken[] | undefined, deps: VetDeps): TtsInput {
  if (tokens && takesMisaki(deps.tts)) return { tokens: ttsTokens(tokens), alphabet: "misaki" };
  return { text: deps.lexicon ? applyLexicon(spoken, deps.lexicon, "text") : plainText(spoken) };
}

const OVERRIDE_LINK = /\[([^\]]+)\]\(\/[^)]*\)/g;

/** Words whose pronunciation the line or the lexicon overrides: the dictionary reading cannot predict them. */
function overrideWords(voiceSpoken: string, lexicon: Lexicon | undefined): string[] {
  const linked = [...voiceSpoken.matchAll(OVERRIDE_LINK)].map((m) => m[1] ?? "");
  const listed = (lexicon?.entries ?? []).filter((e) => e.respell !== undefined || e.phonemes?.misaki !== undefined).map((e) => e.term);
  return [...new Set([...linked, ...listed])];
}

function checkContext(spoken: string, voiceSpoken: string, tokens: G2pToken[] | undefined, deps: VetDeps, policy: VetPolicy): CheckContext {
  return {
    plain: plainText(spoken),
    voiceSpoken,
    tokens,
    stt: deps.stt,
    confirmStt: deps.confirmStt,
    recognizer: deps.recognizer,
    phoneG2p: deps.phoneG2p,
    toIpa: deps.toIpa ?? misakiToIpa,
    table: policy.table,
    overrideWords: overrideWords(voiceSpoken, deps.lexicon),
  };
}

/**
 * Takes until one is fault-free, the budget is spent, or a take repeats the one before it. Every take is
 * checked in full, and replaces the best only through `betterTake`, or by being fault-free.
 */
async function runTakes(run: Run): Promise<{ taken: Taken[]; best: Taken; stopReason: VetReport["stopReason"] }> {
  const lastAttempt = (run.policy.maxRetakes ?? DEFAULT_RETRIES) + 1;
  const taken: Taken[] = [];
  let best: Taken | undefined;
  for (let attempt = 1; attempt <= lastAttempt; attempt++) {
    const prev = taken.at(-1);
    const current = await takeOnce(attempt, run);
    taken.push(current);
    const clean = !current.check.faults.length;
    if (!best || clean || betterTake(best.check, current.check, run.policy.margin)) best = current;
    if (clean) return { taken, best, stopReason: "clean" };
    if (prev && isFutile(heardOf(prev), heardOf(current))) return { taken, best, stopReason: "futile" };
  }
  return { taken, best: best!, stopReason: "budget" };
}

async function takeOnce(attempt: number, run: Run): Promise<Taken> {
  const synthesis = await run.deps.tts.synthesize(run.input, run.deps.voice, run.policy.synthesize);
  const check = await checkTake(synthesis, run.ctx);
  return { take: { attempt, synthesis, transcript: check.transcript }, check };
}

const heardOf = ({ check }: Taken) => ({ phones: check.phones, text: check.transcript.text });

function reportBase(deps: VetDeps, policy: VetPolicy): Omit<VetReport, "precheck" | "takes" | "stopReason"> {
  return {
    tts: deps.tts.id,
    voice: deps.voice,
    ...(deps.g2p ? { g2pVersion: deps.g2p.version } : {}),
    tableVersion: (policy.table ?? englishHeteronyms).version,
    defectOptions: { stt: defectOptionsFor(deps.stt), ...(deps.confirmStt ? { confirmStt: defectOptionsFor(deps.confirmStt) } : {}) },
  };
}

function takeReport({ take, check }: Taken, kept: boolean): TakeReport {
  const { textDiff, defects, phones, hallucinations, tail, heard, undeclaredHeard, faults, dismissed } = check;
  return {
    attempt: take.attempt,
    transcript: check.transcript.text,
    textDiff,
    defects,
    ...(phones === undefined ? {} : { phones }),
    hallucinations,
    tail,
    heard,
    warnings: undeclaredHeard,
    faults,
    dismissed,
    kept,
  };
}

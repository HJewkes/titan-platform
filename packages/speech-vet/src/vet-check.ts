/**
 * The check half of the vet cycle: everything learned about one synthesized take, composed from the
 * existing detectors and handed to `classifyFaults`. It synthesizes nothing and loads no model; the
 * providers arrive in the context.
 */
import { diff, type Audio, type SttProvider, type Transcript, type WordDiff } from "@titan-design/speech-stt";
import { confirmDefects, defectOptionsFor, detectDefects, isUnusualWord, tokenizeWords, type Defect } from "./defects.js";
import { englishHeteronyms, heteronymOccurrences, type HeteronymTable, type PhonemeToken } from "./heteronyms.js";
import {
  chunkWordVerdicts,
  detectHallucinations,
  detectTailArtifact,
  recognizePhones,
  type Hallucination,
  type PhoneRecognizer,
  type TailArtifact,
  type WordVerdict,
} from "./phone-verdicts.js";
import type { PhoneG2p } from "./phones.js";
import { checkHeardReadings, type HeardReading, type HeardReadingOptions, type MisakiToIpa } from "./reading-phones.js";
import { wordDistances, type WordDistance } from "./retake.js";
import { classifyFaults, type DefectFinding, type Fault } from "./vet-decide.js";

/**
 * Pending owner decision D-T11-3. False: an undeclared heteronym the audio contradicts is reported in
 * `TakeCheck.undeclaredHeard` and is no fault. True: those contradictions join `heard` and are classified as reading faults.
 */
export const ESCALATE_UNDECLARED_HETERONYMS = false;

/** The audio of one take; a speech-tts `Synthesis` fits. */
interface CheckedTake {
  audio: Audio;
}

export interface CheckContext {
  /** The line with all markup removed: what the transcript is compared with. */
  plain: string;
  /** The line with its `[w](=reading)` declarations, as the precheck read it. */
  voiceSpoken: string;
  /** The G2P tokens the voice was given; absent for a text voice, which skips the reading check. */
  tokens?: readonly PhonemeToken[];
  stt: SttProvider;
  confirmStt?: SttProvider;
  recognizer?: PhoneRecognizer;
  /** Required with a recognizer: whether misaki may drive verdicts is the caller's call, so there is no default. */
  phoneG2p?: PhoneG2p;
  toIpa: MisakiToIpa;
  table?: HeteronymTable;
  /** Words carrying a pronunciation override; the dictionary reading cannot predict them, so they are judged leniently. */
  overrideWords?: readonly string[];
  /** Defaults to `ESCALATE_UNDECLARED_HETERONYMS`. */
  escalateUndeclared?: boolean;
}

export interface TakeCheck {
  transcript: Transcript;
  textDiff: WordDiff;
  /** Confirmed when `confirmStt` is set; substitutions and omissions carry their word verdicts. */
  defects: DefectFinding[];
  /** The recognizer's cleaned phones; absent without a recognizer. */
  phones?: string;
  hallucinations: Hallucination[];
  tail: TailArtifact | null;
  /** Per-word phone distances for the comparator; empty without a recognizer. */
  distances: Map<string, WordDistance>;
  /** Declared readings, plus contradicted undeclared ones when they are escalated. */
  heard: HeardReading[];
  /** Undeclared heteronyms the audio contradicts, re-declared at their G2P reading; no fault unless escalated. */
  undeclaredHeard: HeardReading[];
  faults: Fault[];
  /** Substitutions the phones clear or cannot judge. */
  dismissed: WordVerdict[];
}

interface PhoneFindings {
  phones?: string;
  hallucinations: Hallucination[];
  tail: TailArtifact | null;
  distances: Map<string, WordDistance>;
  verdicts: WordVerdict[];
}

const NO_PHONES: PhoneFindings = { hallucinations: [], tail: null, distances: new Map(), verdicts: [] };

export async function checkTake(take: CheckedTake, ctx: CheckContext): Promise<TakeCheck> {
  if (ctx.recognizer && !ctx.phoneG2p) throw new TypeError("checkTake: a recognizer needs a phoneG2p; there is no default");
  const transcript = await ctx.stt.transcribe(take.audio);
  const found = await confirmedDefects(take.audio, transcript, ctx);
  const phones = ctx.recognizer ? await phoneFindings(take.audio, found, ctx.recognizer, ctx) : NO_PHONES;
  const defects = withVerdicts(found, phones);
  const { heard, undeclaredHeard } = heardReadings(phones.phones, ctx);
  const escalate = ctx.escalateUndeclared ?? ESCALATE_UNDECLARED_HETERONYMS;
  const readings = escalate ? [...heard, ...undeclaredHeard] : heard;
  const { faults, dismissed } = classifyFaults({ hallucinations: phones.hallucinations, tail: phones.tail, defects, heard: readings });
  return {
    transcript,
    textDiff: diff(ctx.plain, transcript),
    defects,
    ...(phones.phones === undefined ? {} : { phones: phones.phones }),
    hallucinations: phones.hallucinations,
    tail: phones.tail,
    distances: phones.distances,
    heard: readings,
    undeclaredHeard,
    faults,
    dismissed,
  };
}

async function confirmedDefects(audio: Audio, transcript: Transcript, ctx: CheckContext): Promise<Defect[]> {
  const base = detectDefects(ctx.plain, transcript, defectOptionsFor(ctx.stt));
  if (!ctx.confirmStt) return base;
  const second = await ctx.confirmStt.transcribe(audio);
  return confirmDefects(base, ctx.plain, second, defectOptionsFor(ctx.confirmStt));
}

/** The words a phone verdict can judge: those of substitution and omission defects. */
function defectWords(defect: Defect): string[] {
  return defect.kind === "low_confidence" ? [] : tokenizeWords(defect.expected).map((t) => t.original);
}

async function phoneFindings(audio: Audio, defects: readonly Defect[], recognizer: PhoneRecognizer, ctx: CheckContext): Promise<PhoneFindings> {
  const actual = await recognizePhones(recognizer, audio);
  const options = { g2p: ctx.phoneG2p! };
  const targets = [...new Set(defects.flatMap(defectWords))];
  const unusual = [...tokenizeWords(ctx.plain).map((t) => t.original).filter(isUnusualWord), ...(ctx.overrideWords ?? [])];
  return {
    phones: actual,
    hallucinations: detectHallucinations(ctx.plain, actual, options),
    tail: detectTailArtifact(ctx.plain, actual, options),
    distances: wordDistances(ctx.plain, actual, { ...options, targets, unusual }),
    verdicts: chunkWordVerdicts(ctx.plain, actual, { ...options, targets, unusual }),
  };
}

function withVerdicts(defects: readonly Defect[], phones: PhoneFindings): DefectFinding[] {
  return defects.map((defect) => {
    const { kind, expected, heard, severity } = defect;
    const finding: DefectFinding = { kind, expected, heard, severity };
    const words = new Set(defectWords(defect));
    const verdicts = phones.verdicts.filter((v) => words.has(v.word));
    // No verdict for the defect's words (alignment found none) leaves it unadjudicated, not cleared.
    return phones.phones !== undefined && verdicts.length ? { ...finding, verdicts } : finding;
  });
}

function heardReadings(phones: string | undefined, ctx: CheckContext): { heard: HeardReading[]; undeclaredHeard: HeardReading[] } {
  if (phones === undefined || !ctx.tokens) return { heard: [], undeclaredHeard: [] };
  const options = { toIpa: ctx.toIpa, table: ctx.table ?? englishHeteronyms };
  return {
    heard: checkHeardReadings(ctx.voiceSpoken, ctx.tokens, phones, options),
    undeclaredHeard: undeclaredContradictions(ctx.voiceSpoken, ctx.tokens, phones, options),
  };
}

/**
 * Re-declares each undeclared heteronym at the reading G2P gave it and checks it with `checkHeardReadings`
 * unchanged, so only contradictions of that reading remain. A reading G2P left `unknown` has nothing to declare.
 */
function undeclaredContradictions(
  voiceSpoken: string,
  tokens: readonly PhonemeToken[],
  phones: string,
  options: HeardReadingOptions & { table: HeteronymTable },
): HeardReading[] {
  const undeclared = new Map<number, string>();
  for (const { tokenIndex, finding } of heteronymOccurrences(voiceSpoken, tokens, options.table)) {
    if (finding.status === "warn" && finding.reading !== "unknown") undeclared.set(tokenIndex, finding.reading);
  }
  if (!undeclared.size) return [];
  // Declared occurrences stay plain here, so this pass reads only the re-declared ones.
  const spoken = tokens.map((t, i) => (undeclared.has(i) ? `[${t.text}](=${undeclared.get(i)})` : t.text) + t.whitespace).join("");
  return checkHeardReadings(spoken, tokens, phones, options).filter((r) => r.status === "fail");
}

/**
 * Take selection, a port of the audiobook backend's `tts/verified.py` (the re-roll loop) and the
 * tail-fix half of `scripts/fix_pass.py` (`keepTake`, regressions, best-of-N). Every model or file
 * touch is injected, so nothing here synthesizes, recognizes or writes.
 */
import type { Audio } from "@titan-design/speech-stt";
import {
  chunkWordVerdicts,
  detectHallucinations,
  detectTailArtifact,
  recognizePhones,
  type Hallucination,
  type PhoneRecognizer,
  type TailArtifact,
} from "./phone-verdicts.js";
import type { PhoneG2pOptions } from "./phones.js";

/** A take must beat the shipped audio's flagged-word distance by this much to count as an improvement. */
export const KEEP_TAKE_MARGIN = 0.06;
/**
 * How much further an already-faulty word must degrade to count as a regression. Only words the take
 * leaves over the fault threshold are judged: a whole-chunk re-synthesis re-renders every word, so
 * sub-threshold distances jitter and scoring that jitter rejects good takes.
 */
export const WORSE_MARGIN = KEEP_TAKE_MARGIN;
/** Re-rolls after the first take. */
export const DEFAULT_RETRIES = 5;
/** The shortest word, in letters, that a tail check scores for regressions. */
export const MIN_TARGET_WORD_LENGTH = 3;

export interface TakeScore {
  /** Words the take pronounces worse than the shipped audio. */
  brokeWords: number;
  /** Phones the audio runs on with past the last word. */
  strayLength: number;
  /** The flagged word's phone distance; 0 when nothing was flagged. */
  distance: number;
}

/**
 * Whether `take` replaces `shipped`. Never a take that damages a word, however clean its tail. Between
 * the rest, a shorter stray wins outright; at equal stray the distance must fall by more than `margin`,
 * so a tie keeps what is already on disk.
 */
export function keepTake(shipped: TakeScore, take: TakeScore, margin: number = KEEP_TAKE_MARGIN): boolean {
  if (take.brokeWords > 0) return false;
  if (take.strayLength !== shipped.strayLength) return take.strayLength < shipped.strayLength;
  return take.distance < shipped.distance - margin;
}

/** A word's phone distance and whether the audio mispronounces it (`xtts` source). */
export interface WordDistance {
  distance: number;
  faulty: boolean;
}

/**
 * Words this take actively damages: left genuinely mispronounced AND worse than shipped, either because
 * it was fine before or because it was already faulty and has degraded past `margin`. Distances, not a
 * set of faulty words: a word that was already faulty and degrades never enters or leaves such a set.
 */
export function regressions(
  shipped: ReadonlyMap<string, WordDistance>,
  take: ReadonlyMap<string, WordDistance>,
  margin: number = WORSE_MARGIN,
): string[] {
  const out: string[] = [];
  for (const [word, now] of take) {
    if (!now.faulty) continue;
    const was = shipped.get(word) ?? { distance: 0, faulty: false };
    if (!was.faulty || now.distance > was.distance + margin) out.push(word);
  }
  return out.sort();
}

export interface WordDistanceOptions extends PhoneG2pOptions {
  /** Defaults to the words of `text` with at least `MIN_TARGET_WORD_LENGTH` letters. */
  targets?: readonly string[];
  unusual?: Iterable<string>;
}

/** Per-word distance for one rendering's phones, keyed by word. */
export function wordDistances(text: string, actualPhones: string, options: WordDistanceOptions): Map<string, WordDistance> {
  const targets = options.targets ?? defaultTargets(text);
  const out = new Map<string, WordDistance>();
  if (!targets.length) return out;
  for (const v of chunkWordVerdicts(text, actualPhones, { ...options, targets })) {
    out.set(v.word, { distance: v.distance, faulty: v.source === "xtts" });
  }
  return out;
}

function defaultTargets(text: string): string[] {
  const words = text.match(/[\p{L}\p{N}']+/gu) ?? [];
  return words.filter((w) => w.length >= MIN_TARGET_WORD_LENGTH);
}

export interface RawTake<T> {
  /** The caller's handle on the take, such as a file path; returned for the winner. */
  value: T;
  audio: Audio;
}

export interface VerifiedTake<T> {
  value: T;
  /** Takes made, the winner included. */
  attempts: number;
  /** False when every take babbled and the least severe was kept. */
  clean: boolean;
  /** Hallucinations of the kept take. */
  hallucinations: Hallucination[];
}

export interface SynthesizeVerifiedOptions<T> extends PhoneG2pOptions {
  synthesize: (attempt: number) => Promise<RawTake<T>>;
  /** Absent, one plain take is made and returned unchecked. */
  recognizer?: PhoneRecognizer;
  retries?: number;
  minRun?: number;
  /** Called once for every take that is not returned, so temp files do not accumulate. */
  discard?: (value: T) => void | Promise<void>;
}

/**
 * Synthesizes `text`, re-rolling babbled takes. The first hallucination-free take wins; if every attempt
 * babbles, the least severe is kept (the earliest on a tie), so a chunk is never dropped.
 */
export async function synthesizeVerified<T>(text: string, options: SynthesizeVerifiedOptions<T>): Promise<VerifiedTake<T>> {
  const { synthesize, recognizer, discard } = options;
  if (!recognizer) {
    const take = await synthesize(0);
    return { value: take.value, attempts: 1, clean: true, hallucinations: [] };
  }
  const retries = options.retries ?? DEFAULT_RETRIES;
  let best: { value: T; severity: number; hallucinations: Hallucination[] } | undefined;
  const dropped: T[] = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const take = await synthesize(attempt);
    const phones = await recognizePhones(recognizer, take.audio);
    const found = detectHallucinations(text, phones, options);
    if (!found.length) {
      if (best) dropped.push(best.value);
      await discardAll(dropped, discard);
      return { value: take.value, attempts: attempt + 1, clean: true, hallucinations: [] };
    }
    const severity = Math.max(...found.map((h) => h.severity));
    if (!best || severity < best.severity) {
      if (best) dropped.push(best.value);
      best = { value: take.value, severity, hallucinations: found };
    } else {
      dropped.push(take.value);
    }
  }
  await discardAll(dropped, discard);
  return { value: best!.value, attempts: retries + 1, clean: false, hallucinations: best!.hallucinations };
}

async function discardAll<T>(values: readonly T[], discard: ((value: T) => void | Promise<void>) | undefined): Promise<void> {
  for (const value of values) await discard?.(value);
}

export interface TailCandidate<T> {
  label: string;
  /** Synthesizes one take and returns its recognized phones. */
  take: () => Promise<{ value: T; phones: string }>;
}

export interface BestTailTakeOptions<T> extends WordDistanceOptions {
  text: string;
  shippedPhones: string;
  /** The tail artifact the shipped audio was flagged for. */
  before: Pick<TailArtifact, "length">;
  candidates: readonly TailCandidate<T>[];
  margin?: number;
}

export interface TailFix<T> {
  label: string;
  value: T;
  kept: boolean;
  brokeWords: string[];
  afterLength: number;
  afterPhones: string;
}

interface ScoredTail<T> {
  label: string;
  value: T;
  broke: string[];
  art: TailArtifact | null;
}

/**
 * Tries every candidate and returns the best: fewest damaged words first, then shortest stray. It is
 * kept only through `keepTake`, so a take that clears the stray but breaks a word is disqualified
 * outright, and a take no better than the shipped audio never ships.
 */
export async function bestTailTake<T>(options: BestTailTakeOptions<T>): Promise<TailFix<T>> {
  const { text, candidates } = options;
  const margin = options.margin ?? WORSE_MARGIN;
  const shipped = wordDistances(text, options.shippedPhones, options);
  const scored: ScoredTail<T>[] = [];
  for (const candidate of candidates) {
    const { value, phones } = await candidate.take();
    const broke = regressions(shipped, wordDistances(text, phones, options), margin);
    scored.push({ label: candidate.label, value, broke, art: detectTailArtifact(text, phones, options) });
  }
  if (!scored.length) throw new RangeError("bestTailTake needs at least one candidate");
  const strayOf = (t: ScoredTail<T>) => t.art?.length ?? 0;
  const winner = scored.reduce((a, b) => {
    if (b.broke.length !== a.broke.length) return b.broke.length < a.broke.length ? b : a;
    return strayOf(b) < strayOf(a) ? b : a;
  });
  const shippedScore: TakeScore = { brokeWords: 0, strayLength: options.before.length, distance: 0 };
  const takeScore: TakeScore = { brokeWords: winner.broke.length, strayLength: strayOf(winner), distance: 0 };
  return {
    label: winner.label,
    value: winner.value,
    kept: keepTake(shippedScore, takeScore, margin),
    brokeWords: winner.broke,
    afterLength: strayOf(winner),
    afterPhones: winner.art?.phones ?? "",
  };
}

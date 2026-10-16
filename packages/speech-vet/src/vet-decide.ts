/**
 * The decision half of the vet cycle: which findings on a take are faults, which of two faulty takes to
 * keep, when retaking is futile, and what the kept take's remaining faults ask the caller to do. Pure:
 * the checks that produce the findings run elsewhere.
 */
import type { Hallucination, TailArtifact, WordVerdict } from "./phone-verdicts.js";
import type { HeardReading } from "./reading-phones.js";
import { keepTake, regressions, type WordDistance } from "./retake.js";

/**
 * `hallucination`, `tail`, `omission` and `low-confidence` are stochastic: another take of the same input
 * can clear them. `word` and `reading` are the voice's pronunciation, which a retake rarely changes.
 */
export type FaultKind = "hallucination" | "tail" | "omission" | "low-confidence" | "word" | "reading";

export interface Fault {
  kind: FaultKind;
  /** The source word, for word, reading, omission and low-confidence faults. */
  word?: string;
  /** In [0, 1]; for an adjudicated word fault, its phone distance. */
  severity: number;
  detail: string;
}

/** The fields of a speech-vet `Defect` this module reads, plus the verdicts S3 attaches to it. */
export interface DefectFinding {
  kind: "substitution" | "omission" | "low_confidence";
  expected: string;
  heard: string;
  severity: number;
  /** Word verdicts over this defect's words; absent when no recognizer ran, leaving it unadjudicated. */
  verdicts?: readonly WordVerdict[];
}

export interface TakeFindings {
  hallucinations: readonly Hallucination[];
  tail: TailArtifact | null;
  /** Already confirmed when a confirming STT is set. */
  defects: readonly DefectFinding[];
  heard: readonly HeardReading[];
}

export interface Classification {
  faults: Fault[];
  /** Substitution words the phones clear (`whisper`) or cannot judge (`inconclusive`): STT noise, not faults. */
  dismissed: WordVerdict[];
}

const STOCHASTIC_DEFECTS = { omission: "omission", low_confidence: "low-confidence" } as const;

/** Sorts one take's findings into faults and dismissed substitutions. */
export function classifyFaults(findings: TakeFindings): Classification {
  const faults: Fault[] = [];
  const dismissed: WordVerdict[] = [];
  for (const h of findings.hallucinations) {
    faults.push({ kind: "hallucination", severity: h.severity, detail: `babble ${h.phones} at ${h.position}` });
  }
  if (findings.tail) {
    faults.push({ kind: "tail", severity: findings.tail.severity, detail: `stray ${findings.tail.phones}` });
  }
  for (const d of findings.defects) {
    if (d.kind !== "substitution") {
      faults.push({ kind: STOCHASTIC_DEFECTS[d.kind], word: d.expected, severity: d.severity, detail: `heard "${d.heard}"` });
    } else if (!d.verdicts) {
      faults.push({ kind: "word", word: d.expected, severity: d.severity, detail: `heard "${d.heard}", unadjudicated` });
    } else {
      for (const v of d.verdicts) {
        if (v.source !== "xtts") dismissed.push(v);
        else faults.push({ kind: "word", word: v.word, severity: v.distance, detail: `phones ${v.actualPhones}` });
      }
    }
  }
  for (const r of findings.heard) {
    // A reading miss is categorical: its distance measures the fit of the wrong reading, not how wrong it is.
    if (r.status === "fail") faults.push({ kind: "reading", word: r.word, severity: 1, detail: `declared ${r.declared}, heard ${r.heard}` });
  }
  return { faults, dismissed };
}

/** What the comparator reads from a checked take. */
export interface RankedTake {
  hallucinations: readonly Pick<Hallucination, "severity">[];
  tail: Pick<TailArtifact, "length"> | null;
  /** Per-word phone distances, from `wordDistances`; empty without a recognizer. */
  distances: ReadonlyMap<string, WordDistance>;
  faults: readonly Fault[];
}

const maxOf = (values: readonly number[]): number => values.reduce((a, b) => Math.max(a, b), 0);

/**
 * Whether `take` replaces `best`. Lower hallucination severity wins first, as the re-roll loop ranks takes;
 * at equal severity `keepTake` decides, so a take that breaks a word never wins and a tie keeps `best`.
 */
export function betterTake(best: RankedTake, take: RankedTake, margin?: number): boolean {
  const bestSeverity = maxOf(best.hallucinations.map((h) => h.severity));
  const takeSeverity = maxOf(take.hallucinations.map((h) => h.severity));
  if (takeSeverity !== bestSeverity) return takeSeverity < bestSeverity;
  const wordDistance = (t: RankedTake) => maxOf(t.faults.filter((f) => f.kind === "word").map((f) => f.severity));
  return keepTake(
    { brokeWords: 0, strayLength: best.tail?.length ?? 0, distance: wordDistance(best) },
    {
      brokeWords: regressions(best.distances, take.distances, margin).length,
      strayLength: take.tail?.length ?? 0,
      distance: wordDistance(take),
    },
    margin,
  );
}

/** What the takes heard: phones are absent when no recognizer ran. */
export interface HeardTake {
  phones?: string;
  text: string;
}

/** A take identical to the previous one says the voice is deterministic, so further retakes cannot help. */
export function isFutile(prev: HeardTake, take: HeardTake): boolean {
  return prev.phones === take.phones && prev.text === take.text;
}

export type Decision =
  | { status: "accepted" }
  | { status: "needs-override"; word: string; evidence: Fault[] }
  | { status: "needs-rewrite"; span: string; reason: "reading" }
  // Pending owner decision D-T11-4: only stochastic faults remain after the retake budget.
  | { status: "retakes-exhausted"; faults: Fault[] };

/**
 * Maps the kept take's remaining faults to the caller's next step. A word fault asks for an override of
 * its most severe word. A reading fault asks for an override on a voice that takes misaki phonemes, which
 * can force a reading, and a rewrite on a text voice, which cannot.
 */
export function outcome(best: Pick<RankedTake, "faults">, voiceTakesMisaki: boolean): Decision {
  const { faults } = best;
  if (!faults.length) return { status: "accepted" };
  const words = faults.filter((f) => f.kind === "word");
  if (words.length) {
    const worst = words.reduce((a, b) => (b.severity > a.severity ? b : a));
    const word = worst.word ?? "";
    return { status: "needs-override", word, evidence: words.filter((f) => f.word === worst.word) };
  }
  const reading = faults.find((f) => f.kind === "reading");
  if (reading) {
    const word = reading.word ?? "";
    if (voiceTakesMisaki) return { status: "needs-override", word, evidence: faults.filter((f) => f.kind === "reading" && f.word === word) };
    return { status: "needs-rewrite", span: word, reason: "reading" };
  }
  return { status: "retakes-exhausted", faults: [...faults] };
}

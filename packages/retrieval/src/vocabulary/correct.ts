import { editDistance, maxEditDistance } from "./edit-distance.js";
import { termLength } from "./terms.js";

const MIN_QUERY_TERM_LENGTH = 3;
const MAX_CORRECTED_TERMS = 8;
const CANDIDATE_LIMIT = 5000;

export interface VocabEntry {
  /** Stored lowercase. */
  term: string;
  docFrequency: number;
  score: number;
}

/** Where corrections come from. A store-backed table fits this shape, so correction itself needs no database. */
export interface VocabularySource {
  has(term: string): boolean;
  /** Terms whose length in code points is within [minLength, maxLength], highest score first, at most `limit`. */
  candidates(minLength: number, maxLength: number, limit: number): readonly VocabEntry[];
}

/** An in-memory source over a fixed list of entries. */
export function vocabularyFromEntries(entries: readonly VocabEntry[]): VocabularySource {
  const terms = new Set(entries.map((entry) => entry.term));
  const byScore = [...entries].sort((a, b) => b.score - a.score);
  return {
    has: (term) => terms.has(term),
    candidates: (minLength, maxLength, limit) =>
      byScore.filter((entry) => termLength(entry.term) >= minLength && termLength(entry.term) <= maxLength).slice(0, limit),
  };
}

function beats(entry: VocabEntry, distance: number, best: { entry: VocabEntry; distance: number } | null): boolean {
  if (best === null || distance < best.distance) return true;
  if (distance > best.distance) return false;
  if (entry.score !== best.entry.score) return entry.score > best.entry.score;
  return entry.term < best.entry.term;
}

/**
 * The closest known term within the length-scaled distance, ties to the higher
 * score, then to the earlier term. Returns `term` unchanged when it is known or
 * when nothing is close enough; a correction comes back in stored (lowercase) form.
 */
export function findCorrection(term: string, source: VocabularySource): string {
  const lower = term.toLowerCase();
  if (source.has(lower)) return term;
  const length = termLength(lower);
  const allowed = maxEditDistance(length);
  let best: { entry: VocabEntry; distance: number } | null = null;
  for (const entry of source.candidates(length - allowed, length + allowed, CANDIDATE_LIMIT)) {
    const distance = editDistance(lower, entry.term, allowed);
    if (distance === 0) return term;
    if (distance <= allowed && beats(entry, distance, best)) best = { entry, distance };
  }
  return best?.entry.term ?? term;
}

/** Correct each whitespace-separated word of 3 or more characters, the first 8 of them at most. */
export function correctQuery(query: string, source: VocabularySource): { corrected: string; didCorrect: boolean } {
  let didCorrect = false;
  let budget = MAX_CORRECTED_TERMS;
  const words = query.split(/\s+/).filter(Boolean).map((word) => {
    if (termLength(word) < MIN_QUERY_TERM_LENGTH || budget === 0) return word;
    budget--;
    const correction = findCorrection(word, source);
    if (correction === word || correction === word.toLowerCase()) return word;
    didCorrect = true;
    return correction;
  });
  return { corrected: words.join(" "), didCorrect };
}

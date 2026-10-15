import type { TimedToken } from "./timestamps.js";

// Kokoro's context holds 512 ids: the phonemes plus <bos> and <eos>.
const MAX_PHONEMES = 510;
// Split after the strongest punctuation that leaves the rest within the limit; a closer stays with its sentence.
const WATERFALL = ["!.?…", ":;", ",—"].map((marks) => [...marks]);
const BUMPS = [")", "”"];

/** A token after `en_tokenize`: Python rewrites null phonemes to "" in place. */
type Spoken<T extends TimedToken> = Omit<T, "phonemes"> & { readonly phonemes: string };

interface Chunk<T> {
  readonly ps: string;
  readonly tokens: T[];
}

interface Span {
  readonly start: number | null;
  readonly end: number | null;
}

// Python's len() counts code points, not UTF-16 units.
function codePoints(s: string): number {
  return [...s].length;
}

function tokensToPs(tokens: readonly Spoken<TimedToken>[]): string {
  return tokens.map((t) => t.phonemes + (t.whitespace ? " " : "")).join("").trim();
}

function lastIndexOfMark(tokens: readonly Spoken<TimedToken>[], marks: readonly string[]): number {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (marks.includes(tokens[i]?.phonemes ?? "")) return i;
  }
  return -1;
}

/** Port of kokoro 0.9.4 `KPipeline.waterfall_last`: how many of `tokens` the next chunk takes. */
function waterfallLast(tokens: readonly Spoken<TimedToken>[], nextCount: number): number {
  for (const marks of WATERFALL) {
    const mark = lastIndexOfMark(tokens, marks);
    if (mark < 0) continue;
    let z = mark + 1;
    if (BUMPS.includes(tokens[z]?.phonemes ?? "")) z += 1;
    if (nextCount - codePoints(tokensToPs(tokens.slice(0, z))) <= MAX_PHONEMES) return z;
  }
  return tokens.length;
}

/**
 * Port of kokoro 0.9.4 `KPipeline.en_tokenize`, including its empty chunk when a single token
 * overflows an empty buffer. Returns copies; the input tokens are not changed.
 */
export function enTokenize<T extends TimedToken>(tokens: readonly T[]): Chunk<Spoken<T>>[] {
  const chunks: Chunk<Spoken<T>>[] = [];
  let pending: Spoken<T>[] = [];
  let count = 0;
  for (const original of tokens) {
    const token: Spoken<T> = { ...original, phonemes: original.phonemes ?? "" };
    let next = token.phonemes + (token.whitespace ? " " : "");
    const nextCount = count + codePoints(next.trimEnd());
    if (nextCount > MAX_PHONEMES) {
      const z = waterfallLast(pending, nextCount);
      chunks.push({ ps: tokensToPs(pending.slice(0, z)), tokens: pending.slice(0, z) });
      pending = pending.slice(z);
      count = codePoints(tokensToPs(pending));
      if (pending.length === 0) next = next.trimStart();
    }
    pending.push(token);
    count += codePoints(next);
  }
  if (pending.length > 0) chunks.push({ ps: tokensToPs(pending), tokens: pending });
  return chunks;
}

/** The chunks `generate_from_tokens` synthesizes: empty ones skipped, any ps still over 510 cut to 510. */
export function chunkTokens<T extends TimedToken>(tokens: readonly T[]): Chunk<Spoken<T>>[] {
  return enTokenize(tokens)
    .filter((chunk) => chunk.ps !== "")
    .map((chunk) => ({ ...chunk, ps: [...chunk.ps].slice(0, MAX_PHONEMES).join("") }));
}

/** The voice-pack row Kokoro styles a chunk with: `pack[len(ps) - 1]`. kokoro-js 1.2.1 uses `len(ps)`. */
export function styleRow(ps: string): number {
  return codePoints(ps) - 1;
}

/** Flattens per-chunk times onto one clock: each chunk starts where the preceding chunks' samples end. */
export function offsetWords(chunks: readonly { samples: number; times: readonly Span[] }[], sampleRate: number): Span[] {
  const words: Span[] = [];
  let samples = 0;
  for (const chunk of chunks) {
    const shift = samples / sampleRate;
    const move = (t: number | null): number | null => (t === null ? null : t + shift);
    words.push(...chunk.times.map((time) => ({ start: move(time.start), end: move(time.end) })));
    samples += chunk.samples;
  }
  return words;
}

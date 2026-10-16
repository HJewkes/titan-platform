import { deflateSync } from "node:zlib";
import type { Segment } from "./schemas.js";

/** One generated token: its log-prob over the full vocab, and over text tokens only (`null` for ids at or past EOT). */
interface TokenScore {
  id: number;
  logprob: number;
  textLogprob: number | null;
}

/** One decode window: Whisper's `generate` runs once per 30 s chunk, each starting again from its prompt. */
export interface CapturedWindow {
  promptLength: number;
  tokens: TokenScore[];
}

/** The slice of a transformers.js logits `Tensor` the capture reads: `logits[batch].data` is a view, not a copy. */
interface LogitsBatch {
  readonly [batch: number]: { readonly data: ArrayLike<number> } | undefined;
}

type Decode = (ids: number[]) => string;

// Python's `string.punctuation`, which faster-whisper's word split tests with a substring check.
const PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const REPLACEMENT = "�";

function logSumExp(row: ArrayLike<number>, end: number): number {
  let max = -Infinity;
  for (let v = 0; v < end; v++) if (row[v]! > max) max = row[v]!;
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (let v = 0; v < end; v++) sum += Math.exp(row[v]! - max);
  return max + Math.log(sum);
}

function argmax(row: ArrayLike<number>): number {
  let best = 0;
  for (let v = 1; v < row.length; v++) if (row[v]! > row[best]!) best = v;
  return best;
}

function scoreToken(row: ArrayLike<number>, id: number, eotId: number): TokenScore {
  const logprob = row[id]! - logSumExp(row, row.length);
  const textLogprob = id < eotId ? row[id]! - logSumExp(row, eotId) : null;
  return { id, logprob, textLogprob };
}

/**
 * A logits processor that records each greedy step's chosen token. The step's choice is only known at the next call,
 * as the last input id, so the row is held by reference and scored then: processors that run after this one edit it
 * in place, and the score must see their edits. A call whose input did not grow starts a new window; the last step of
 * a window resolves by argmax, which is the greedy choice.
 */
export function createLogprobCapture(eotId: number) {
  const done: CapturedWindow[] = [];
  let current: CapturedWindow | null = null;
  let pending: ArrayLike<number> | null = null;
  let lastLength = 0;

  const resolve = (id: number) => {
    if (current && pending) current.tokens.push(scoreToken(pending, id, eotId));
    pending = null;
  };
  const closeWindow = () => {
    if (pending) resolve(argmax(pending));
    if (current) done.push(current);
    current = null;
  };

  const processor = <L extends LogitsBatch>(inputIds: readonly (readonly (number | bigint)[])[], logits: L): L => {
    const ids = inputIds[0] ?? [];
    if (current && ids.length > lastLength) resolve(Number(ids[ids.length - 1]));
    else {
      closeWindow();
      current = { promptLength: ids.length, tokens: [] };
    }
    pending = logits[0]?.data ?? null;
    lastLength = ids.length;
    return logits;
  };
  const windows = (): CapturedWindow[] => {
    closeWindow();
    return [...done];
  };
  return { processor, windows };
}

/** faster-whisper's `split_tokens_on_unicode`: tokens that decode to a lone U+FFFD join the next until they decode cleanly. */
function splitOnUnicode(tokens: TokenScore[], decode: Decode): { text: string; tokens: TokenScore[] }[] {
  const full = decode(tokens.map((t) => t.id));
  const out: { text: string; tokens: TokenScore[] }[] = [];
  let group: TokenScore[] = [];
  let offset = 0;
  for (const token of tokens) {
    group.push(token);
    const text = decode(group.map((t) => t.id));
    const at = text.indexOf(REPLACEMENT);
    if (at === -1 || full[at + offset] === REPLACEMENT) {
      out.push({ text, tokens: group });
      group = [];
      offset += text.length;
    }
  }
  return out;
}

const isPunctuation = (text: string) => PUNCTUATION.includes(text.trim());

/**
 * faster-whisper's word split over a window's text tokens (`split_tokens_on_spaces`, with special tokens removed first
 * as `find_alignment` does): a sub-word starts a new word when it starts with a space or is punctuation. Punctuation words are dropped, as `merge_punctuations` leaves its neighbour's probability alone.
 * Each word's probability is the mean of its tokens' text-vocab probabilities.
 */
export function windowWords(window: CapturedWindow, decode: Decode): { text: string; probability: number }[] {
  const text = window.tokens.filter((t) => t.textLogprob !== null);
  const words: { text: string; tokens: TokenScore[] }[] = [];
  for (const sub of splitOnUnicode(text, decode)) {
    const last = words.at(-1);
    if (!last || sub.text.startsWith(" ") || isPunctuation(sub.text)) words.push(sub);
    else words[words.length - 1] = { text: last.text + sub.text, tokens: [...last.tokens, ...sub.tokens] };
  }
  return words
    .filter((w) => !isPunctuation(w.text))
    .map((w) => ({ text: w.text, probability: mean(w.tokens.map((t) => Math.exp(t.textLogprob!))) }));
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * One window as a `Segment`, with faster-whisper's confidence fields: `avgLogprob` sums every generated token's
 * full-vocab log-prob, EOT included, over the text-token count plus one; `compressionRatio` is the trimmed text's
 * UTF-8 length over its zlib-deflated length.
 */
export function windowSegment(window: CapturedWindow, decode: Decode, span: { start: number; end: number }): Segment {
  const textIds = window.tokens.filter((t) => t.textLogprob !== null).map((t) => t.id);
  const text = decode(textIds).trim();
  const total = window.tokens.reduce((sum, t) => sum + t.logprob, 0);
  const bytes = Buffer.from(text, "utf8");
  return {
    text,
    start: span.start,
    end: span.end,
    avgLogprob: total / (textIds.length + 1),
    compressionRatio: bytes.length / deflateSync(bytes).length,
  };
}

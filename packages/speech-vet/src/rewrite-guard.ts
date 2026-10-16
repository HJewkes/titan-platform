/**
 * The guard a rewrite candidate passes before it may replace a sentence. It is pure and returns every reason a
 * candidate fails, so a product can show a reviewer why it was dropped. Numbers, names, protected terms and the
 * line's other markup must survive exactly; content and length may drift only a little.
 */
import { plainText, splitLinks } from "./markup.js";
import { DEFAULT_NORMALIZE_STEPS, normalize, type NormalizeStep } from "./normalize.js";
import { NUMBER_WORDS } from "./number-words.js";
import { wholeWords } from "./respell.js";

export interface GuardOptions {
  /** Run on both sides before numbers, terms and length are compared. */
  steps?: readonly NormalizeStep[];
  /** Terms (a lexicon's, say) that must survive whenever the source contains them. */
  protectedTerms?: readonly string[];
  maxDroppedTerms?: number;
  /** Allowed change in word count, as a fraction of the source's words. */
  lengthTolerance?: number;
  /** The least change in word count always allowed, so a short sentence can still be rephrased. */
  minLengthSlack?: number;
}

export const DEFAULT_GUARD_OPTIONS = {
  maxDroppedTerms: 1,
  lengthTolerance: 0.25,
  minLengthSlack: 3,
} as const satisfies GuardOptions;

export type GuardRule = "empty" | "number" | "entity" | "markup" | "terms" | "length";

export interface GuardRejection {
  rule: GuardRule;
  detail: string;
}

interface Side {
  raw: string;
  plain: string;
  normalized: string;
}

/** Every reason `candidate` may not replace `source`; empty when it may. `span` is the flagged word, whose own markup may go. */
export function guardRewrite(source: string, candidate: string, span: string, opts: GuardOptions = {}): GuardRejection[] {
  const steps = opts.steps ?? DEFAULT_NORMALIZE_STEPS;
  const side = (raw: string): Side => {
    const plain = plainText(raw);
    return { raw, plain, normalized: plainText(normalize(plain, steps)) };
  };
  const from = side(source);
  const to = side(candidate);
  if (to.plain.trim() === "") return [{ rule: "empty", detail: "the candidate has no text" }];
  return [
    ...numberRejections(from, to),
    ...entityRejections(from, to, opts.protectedTerms ?? []),
    ...markupRejections(from, to, span),
    ...termRejections(from, to, opts.maxDroppedTerms ?? DEFAULT_GUARD_OPTIONS.maxDroppedTerms),
    ...lengthRejections(from, to, opts),
  ];
}

function numbersIn(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => /^\d+$/.test(token) || NUMBER_WORDS.has(token));
}

/** What `left` holds more often than `right`, as a list with repeats. */
function surplus(left: readonly string[], right: readonly string[]): string[] {
  const remaining = [...right];
  return left.filter((item) => {
    const at = remaining.indexOf(item);
    if (at === -1) return true;
    remaining.splice(at, 1);
    return false;
  });
}

function numberRejections(from: Side, to: Side): GuardRejection[] {
  const before = numbersIn(from.normalized);
  const after = numbersIn(to.normalized);
  const dropped = surplus(before, after);
  const added = surplus(after, before);
  if (dropped.length === 0 && added.length === 0) return [];
  const parts = [dropped.length ? `dropped ${dropped.join(" ")}` : "", added.length ? `added ${added.join(" ")}` : ""];
  return [{ rule: "number", detail: parts.filter(Boolean).join("; ") }];
}

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

function isEntity(core: string, sentenceInitial: boolean): boolean {
  if (/\p{L}/u.test(core) && /\p{N}/u.test(core)) return true;
  if (/^\p{Lu}{2,}$/u.test(core)) return true;
  const pronounI = core.replace(/'.*$/, "") === "I";
  return /^\p{Lu}/u.test(core) && !sentenceInitial && !pronounI;
}

/** A heuristic for names: capitalized words not opening a sentence, all-caps tokens and tokens mixing letters and digits. */
function namedEntities(plain: string): string[] {
  const tokens = plain.split(/\s+/).filter(Boolean);
  const entities = tokens.flatMap((token, i) => {
    const core = token.replace(EDGE_PUNCTUATION, "");
    const sentenceInitial = i === 0 || /[.?!]["')\]]*$/.test(tokens[i - 1] ?? "");
    return core !== "" && isEntity(core, sentenceInitial) ? [core] : [];
  });
  return [...new Set(entities)];
}

const containsWord = (text: string, word: string): boolean => wholeWords([word])?.test(text) ?? false;

function entityRejections(from: Side, to: Side, protectedTerms: readonly string[]): GuardRejection[] {
  const present = protectedTerms.filter((term) => containsWord(from.plain, term));
  return [...new Set([...namedEntities(from.plain), ...present])]
    .filter((entity) => !containsWord(to.plain, entity))
    .map((entity) => ({ rule: "entity", detail: `dropped ${entity}` }));
}

const linksIn = (raw: string): string[] =>
  splitLinks(raw)
    .filter((segment) => segment.kind === "link")
    .map((segment) => segment.text);

function markupRejections(from: Side, to: Side, span: string): GuardRejection[] {
  const spanWord = span.toLowerCase();
  const kept = linksIn(from.raw).filter((link) => plainText(link).toLowerCase() !== spanWord);
  return surplus(kept, linksIn(to.raw)).map((link) => ({ rule: "markup", detail: `dropped or altered ${link}` }));
}

function termRejections(from: Side, to: Side, maxDropped: number): GuardRejection[] {
  const kept = contentTerms(to.normalized);
  const dropped = [...contentTerms(from.normalized)].filter((term) => !kept.has(term));
  if (dropped.length <= maxDropped) return [];
  return [{ rule: "terms", detail: `dropped ${dropped.length} content terms (${dropped.join(", ")}), at most ${maxDropped}` }];
}

/** Letter and digit runs, so a path's growth is only the symbol words its rewrite adds. */
const wordCount = (text: string): number => text.match(/[\p{L}\p{N}']+/gu)?.length ?? 0;

function lengthRejections(from: Side, to: Side, opts: GuardOptions): GuardRejection[] {
  const tolerance = opts.lengthTolerance ?? DEFAULT_GUARD_OPTIONS.lengthTolerance;
  const slack = opts.minLengthSlack ?? DEFAULT_GUARD_OPTIONS.minLengthSlack;
  const before = wordCount(from.normalized);
  const after = wordCount(to.normalized);
  const allowed = Math.max(before * tolerance, slack);
  if (Math.abs(after - before) <= allowed) return [];
  return [{ rule: "length", detail: `${before} words became ${after}, at most ${allowed} change` }];
}

// Moved verbatim from explainer's lint-text, which imports it from here.
const STOPWORDS = new Set(
  ("the a an and or but so of to in on at by for with from into onto as is are was were be been it its this that these those " +
    "there their they them then than what which who whom where when why how does do did can could will would should may " +
    "might must has have had not no one two three four five six seven eight nine ten every each all any some more most " +
    "here now just also only very your you our we us his her he she chapter chapters about after before over under").split(" "),
);

// A crude suffix fold, enough for "reader", "reads" and "reading" to meet; no lexicon ships with it.
const stem = (word: string): string => word.replace(/(ing|ers|er|ed|es|s)$/, "") || word;

/** Lower-cased, stemmed content words, so "the reader" and "reads it" share a term. */
export function contentTerms(text: string): Set<string> {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 ? stem(w) : w));
  return new Set(terms);
}

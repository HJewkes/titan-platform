/**
 * The rewriter: when a text voice cannot be made to say a span, replace the sentence holding it. A reviewed
 * rewrite is a pin and wins outright; otherwise each candidate source is asked in order, every candidate passes
 * the guard before it costs a take, and only one that re-vets `accepted` is pinned. The package makes no model
 * call: an LLM arrives as an injected `CandidateSource`, and `symbolRules` is the pure rule tier.
 */
import { countOccurrences, plainText, splitLinks } from "./markup.js";
import { guardRewrite, type GuardOptions, type GuardRejection } from "./rewrite-guard.js";
import { splitSentences, type RewritePins, type SentencePiece } from "./rewrite-pins.js";
import { vet, type VetDeps, type VetPolicy, type VetResult } from "./vet.js";

export interface CandidateSource {
  id: string;
  /** Up to `k` replacements for `sentence`; `reason` says why it needs one (a vet `needs-rewrite` reason). */
  candidates(sentence: string, reason: string, k: number): Promise<string[]>;
}

export const SYMBOL_WORDS: readonly (readonly [string, string])[] = [
  ["/", "slash"],
  ["_", "underscore"],
  [".", "dot"],
  ["@", "at"],
  ["&", "and"],
  ["%", "percent"],
  ["#", "number"],
  ["+", "plus"],
  ["=", "equals"],
];

const SENTENCE_END = new Set([".", "?", "!"]);

// A sentence-ending mark is spelled only between two letters, so a final period or a decimal is left alone.
function spellKey(token: string, key: string, word: string): string {
  if (SENTENCE_END.has(key)) return token.replace(new RegExp(`(?<=\\p{L})\\${key}(?=\\p{L})`, "gu"), ` ${word} `);
  return token.split(key).join(` ${word} `);
}

function spellToken(token: string, table: readonly (readonly [string, string])[]): string {
  if (!/[\p{L}\p{N}]/u.test(token)) return token;
  const spelled = table.reduce((text, [key, word]) => spellKey(text, key, word), token);
  return spelled.replace(/\s+/g, " ").trim();
}

/** The rule tier: spells each table key inside a word-bearing token, outside markup. Offers nothing when nothing changes. */
export function symbolRules(table: readonly (readonly [string, string])[] = SYMBOL_WORDS): CandidateSource {
  return {
    id: "rules:symbols",
    candidates: (sentence) => {
      const spelled = splitLinks(sentence)
        .map((s) => (s.kind === "link" ? s.text : s.text.replace(/\S+/g, (token) => spellToken(token, table))))
        .join("");
      return Promise.resolve(spelled === sentence ? [] : [spelled]);
    },
  };
}

export interface RewriteDeps {
  vet: VetDeps;
  pins: RewritePins;
  /** Asked in order, so put the rule tier before an LLM. */
  sources: readonly CandidateSource[];
}

export interface RewritePolicy {
  vet?: VetPolicy;
  /** Candidates asked of each source; default 3. */
  k?: number;
  /** Protected terms come from `deps.vet.lexicon`. */
  guard?: Omit<GuardOptions, "protectedTerms">;
}

interface Tried {
  source: string;
  candidate: string;
  rejections: GuardRejection[];
  vetStatus?: string;
}

export type RewriteResult =
  | { status: "pinned"; line: string }
  | { status: "refused"; reason: "pinned-span"; line: string }
  | { status: "rewritten"; line: string; sentence: string; rewrite: string; source: string; result: VetResult }
  | { status: "no-candidate"; tried: Tried[] };

const DEFAULT_K = 3;

interface Target {
  pieces: SentencePiece[];
  at: number;
  sentence: string;
}

function findTarget(line: string, span: string): Target {
  const pieces = splitSentences(line);
  const at = pieces.findIndex((piece) => countOccurrences(plainText(piece.text), span) > 0);
  const piece = pieces[at];
  if (!piece) throw new RangeError(`rewriteLine: the span "${span}" is not in the line`);
  return { pieces, at, sentence: piece.text.trim() };
}

const keepEdges = (text: string, rewrite: string): string =>
  (/^\s*/.exec(text)?.[0] ?? "") + rewrite + (/\s*$/.exec(text)?.[0] ?? "");

/** The line with only the target sentence replaced; its surrounding whitespace and every other sentence stay byte-identical. */
function splice({ pieces, at }: Target, rewrite: string): string {
  return pieces.map(({ text, gap }, i) => (i === at ? keepEdges(text, rewrite) : text) + gap).join("");
}

/**
 * Rewrites the sentence holding `need.span`. A pin resolves it with no source asked; a sentence that is itself a
 * pinned rewrite is refused. The caller saves `deps.pins` after a `rewritten` result.
 */
export async function rewriteLine(line: string, need: { span: string; reason: string }, deps: RewriteDeps, policy: RewritePolicy = {}): Promise<RewriteResult> {
  const target = findTarget(line, need.span);
  const pinned = deps.pins.get(target.sentence);
  if (pinned !== undefined) return { status: "pinned", line: splice(target, pinned) };
  if (deps.pins.isPinnedRewrite(target.sentence)) return { status: "refused", reason: "pinned-span", line };
  const guard: GuardOptions = { ...policy.guard, protectedTerms: deps.vet.lexicon?.entries.map((e) => e.term) ?? [] };
  const tried: Tried[] = [];
  for (const source of deps.sources) {
    const candidates = (await source.candidates(target.sentence, need.reason, policy.k ?? DEFAULT_K)).slice(0, policy.k ?? DEFAULT_K);
    for (const candidate of candidates) {
      const rejections = guardRewrite(target.sentence, candidate, need.span, guard);
      if (rejections.length) {
        tried.push({ source: source.id, candidate, rejections });
        continue;
      }
      const candidateLine = splice(target, candidate.trim());
      const result = await vet(candidateLine, deps.vet, policy.vet);
      if (result.status === "accepted") {
        deps.pins.put(target.sentence, candidate.trim(), source.id);
        return { status: "rewritten", line: candidateLine, sentence: target.sentence, rewrite: candidate.trim(), source: source.id, result };
      }
      tried.push({ source: source.id, candidate, rejections, vetStatus: result.status });
    }
  }
  return { status: "no-candidate", tried };
}

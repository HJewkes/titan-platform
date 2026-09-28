/**
 * Verdict grammar (TP-409 S1). A verdict line either contains the word
 * `verdict` followed by a token, or begins (after optional markdown) with one
 * of the four line-start tokens. PR references are read from the verdict
 * line, or from the message's first line when the verdict line names none.
 * Every scan is a single bounded pass: no unbounded backtracking, so a
 * pathological single-line message still parses in linear time.
 */

export type Verdict = "approve" | "changes_requested";

export interface ReviewVerdictMatch {
  verdict: Verdict;
  repo: string | null;
  repoHint: string | null;
  number: number;
}

interface TokenSpec {
  words: string[];
  verdict: Verdict;
}

const ALL_TOKENS: TokenSpec[] = [
  { words: ["APPROVE"], verdict: "approve" },
  { words: ["APPROVED"], verdict: "approve" },
  { words: ["LGTM"], verdict: "approve" },
  { words: ["CHANGES", "REQUESTED"], verdict: "changes_requested" },
  { words: ["REQUEST", "CHANGES"], verdict: "changes_requested" },
  { words: ["REQUESTED", "CHANGES"], verdict: "changes_requested" },
  { words: ["NEEDS", "CHANGES"], verdict: "changes_requested" },
  { words: ["BLOCKED"], verdict: "changes_requested" },
  { words: ["BLOCKING"], verdict: "changes_requested" },
];

const LINE_START_TOKENS: TokenSpec[] = [
  { words: ["APPROVE"], verdict: "approve" },
  { words: ["APPROVED"], verdict: "approve" },
  { words: ["CHANGES", "REQUESTED"], verdict: "changes_requested" },
  { words: ["REQUEST", "CHANGES"], verdict: "changes_requested" },
];

const SEPARATORS = new Set([" ", "_", "-"]);
const MARKDOWN_PREFIX = new Set(["#", "*", "_", ">", "-", "`"]);

/** Never a repo hint: verdict-token words, and common fillers around a PR mention. */
const REJECTED_HINT_WORDS = new Set([
  "approve", "approved", "lgtm", "changes", "requested", "request", "needs", "blocked", "blocking", "verdict",
  "pr", "pull", "see", "on", "for", "of", "in", "and", "to", "the", "review", "reviewed", "re",
]);

/** One entry per (repo-or-hint, number) pair named on a verdict line; a later line for the same pair replaces the earlier one. */
export function parseReviewVerdicts(text: string): ReviewVerdictMatch[] {
  const lines = text.split("\n");
  const firstLineRefs = findPrRefs(lines[0] ?? "");
  const byKey = new Map<string, ReviewVerdictMatch>();
  for (const line of lines) {
    const verdict = lineVerdict(line);
    if (!verdict) continue;
    const refs = findPrRefs(line);
    for (const ref of refs.length > 0 ? refs : firstLineRefs) {
      const match: ReviewVerdictMatch = { verdict, repo: ref.repo, repoHint: ref.repoHint, number: ref.number };
      byKey.set(dedupeKey(match), match);
    }
  }
  return [...byKey.values()];
}

function dedupeKey(match: ReviewVerdictMatch): string {
  const repoKey = match.repo ?? match.repoHint?.toLowerCase() ?? "";
  return `${repoKey}\u0000${match.number}`;
}

function lineVerdict(line: string): Verdict | null {
  return verdictWordMatch(line) ?? lineStartMatch(line);
}

const VERDICT_WORD_RE = /\bverdict\b/gi;

/** Scans every `verdict` occurrence; the first that resolves to a token wins. */
function verdictWordMatch(line: string): Verdict | null {
  VERDICT_WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VERDICT_WORD_RE.exec(line))) {
    const verdict = tokenAfterVerdict(line, match.index + match[0].length);
    if (verdict) return verdict;
  }
  return null;
}

function at(text: string, pos: number): string {
  return pos >= 0 && pos < text.length ? text[pos]! : "";
}

/** Up to three punctuation characters, then any amount of whitespace, then a token. */
function tokenAfterVerdict(line: string, from: number): Verdict | null {
  let cursor = from;
  let punct = 0;
  while (punct < 3 && /[^\w\s]/.test(at(line, cursor))) {
    cursor++;
    punct++;
  }
  while (/\s/.test(at(line, cursor))) cursor++;
  return matchTokenAt(line, cursor, ALL_TOKENS);
}

function lineStartMatch(line: string): Verdict | null {
  let cursor = 0;
  while (/\s/.test(at(line, cursor)) || MARKDOWN_PREFIX.has(at(line, cursor))) cursor++;
  return matchTokenAt(line, cursor, LINE_START_TOKENS);
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function matchWord(text: string, pos: number, word: string): number | null {
  if (pos + word.length > text.length) return null;
  for (let i = 0; i < word.length; i++) {
    if (at(text, pos + i).toUpperCase() !== word[i]) return null;
  }
  return pos + word.length;
}

function matchSpec(text: string, pos: number, words: string[]): number | null {
  let cursor = pos;
  for (let i = 0; i < words.length; i++) {
    if (i > 0) {
      if (!SEPARATORS.has(at(text, cursor))) return null;
      cursor += 1;
    }
    const next = matchWord(text, cursor, words[i]!);
    if (next === null) return null;
    cursor = next;
  }
  return cursor;
}

function matchTokenAt(text: string, pos: number, tokens: TokenSpec[]): Verdict | null {
  for (const spec of tokens) {
    const end = matchSpec(text, pos, spec.words);
    if (end !== null && !isWordChar(at(text, end))) return spec.verdict;
  }
  return null;
}

interface Span {
  start: number;
  end: number;
}

interface RawRef extends Span {
  repo: string | null;
  repoHint: string | null;
  number: number;
}

const URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;
const REPO_NUM_RE = /\b([\w.-]+)\/([\w.-]+)#(\d+)\b/g;
const HASH_RE = /#\s*(\d+)/g;
const PR_NO_HASH_RE = /\bPR\s+(\d+)\b/gi;

function overlaps(refs: Span[], start: number, end: number): boolean {
  return refs.some((r) => start < r.end && end > r.start);
}

function span(m: RegExpMatchArray, fields: { repo: string | null; repoHint: string | null; number: number }): RawRef {
  return { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, ...fields };
}

/** PR references on one line, left to right, in precedence order: URL, owner/repo#n, then hinted or bare numbers. */
function findPrRefs(line: string): RawRef[] {
  const refs: RawRef[] = [];
  for (const m of line.matchAll(URL_RE)) refs.push(span(m, { repo: `${m[1]}/${m[2]}`, repoHint: null, number: Number(m[3]) }));
  for (const m of line.matchAll(REPO_NUM_RE)) {
    if (overlaps(refs, m.index ?? 0, (m.index ?? 0) + m[0].length)) continue;
    refs.push(span(m, { repo: `${m[1]}/${m[2]}`, repoHint: null, number: Number(m[3]) }));
  }
  for (const m of line.matchAll(HASH_RE)) {
    if (overlaps(refs, m.index ?? 0, (m.index ?? 0) + m[0].length)) continue;
    refs.push(span(m, { repo: null, repoHint: hintBefore(line, m.index ?? 0), number: Number(m[1]) }));
  }
  for (const m of line.matchAll(PR_NO_HASH_RE)) {
    if (overlaps(refs, m.index ?? 0, (m.index ?? 0) + m[0].length)) continue;
    refs.push(span(m, { repo: null, repoHint: null, number: Number(m[1]) }));
  }
  return refs.sort((a, b) => a.start - b.start);
}

function precedingWord(line: string, pos: number): { word: string; start: number } {
  let end = pos;
  while (end > 0 && /\s/.test(at(line, end - 1))) end--;
  let start = end;
  while (start > 0 && /[\w-]/.test(at(line, start - 1))) start--;
  return { word: line.slice(start, end), start };
}

function validHint(word: string): boolean {
  return word.length > 0 && !REJECTED_HINT_WORDS.has(word.toLowerCase());
}

/**
 * `<repo> #<n>` and `<repo> PR #<n>` keep the repo word, when it is not a verdict token or a
 * filler word. A rejected candidate yields no hint; the search never looks further left.
 */
function hintBefore(line: string, hashIndex: number): string | null {
  const { word, start } = precedingWord(line, hashIndex);
  if (word.toLowerCase() !== "pr") return validHint(word) ? word : null;
  const before = precedingWord(line, start);
  return validHint(before.word) ? before.word : null;
}

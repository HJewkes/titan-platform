import type { L0Check, L0Result } from "./eval-l0.js";
import { ruleRow } from "./lint-text.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";

/** One gathered fact, of any profile: its id plus whatever fields the gather wrote. */
export interface GatheredFact {
  id: string;
  [field: string]: unknown;
}

export type Claim =
  | { kind: "pr"; text: string; n: number; repo?: string }
  | { kind: "task"; text: string; id: string }
  | { kind: "count"; text: string; n: number; noun?: string; qualifiers: string[] };

/** A claim no gathered fact backs, with the fact that came closest. */
export interface ClaimFinding {
  beat: string;
  claim: string;
  nearest: string;
}

export const CLAIMS_CHECK_ID = "Q-E20";

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: Readonly<Record<string, number>> = { thousand: 1000, million: 1_000_000 };
const NUMBER_WORD = `(?:(?:${TENS.join("|")})(?:-(?:${UNITS.slice(1, 10).join("|")}))?|${UNITS.join("|")}|hundred|thousand|million)`;
const NUMBER_RUN = new RegExp(`\\b${NUMBER_WORD}(?:(?:\\s+and)?\\s+${NUMBER_WORD})*\\b`, "gi");

type WordKind = "small" | "tens" | "hundred" | "scale";

function wordValue(word: string): { kind: WordKind; value: number } {
  if (word === "hundred") return { kind: "hundred", value: 100 };
  if (SCALES[word]) return { kind: "scale", value: SCALES[word] };
  const [head = "", tail] = word.split("-");
  const tens = TENS.indexOf(head);
  if (tens < 0) return { kind: "small", value: UNITS.indexOf(head) };
  return { kind: tail ? "small" : "tens", value: (tens + 2) * 10 + (tail ? UNITS.indexOf(tail) : 0) };
}

const continues = (last: WordKind | undefined, next: WordKind): boolean =>
  last === undefined || next === "hundred" || next === "scale" || last === "hundred" || last === "scale" || (last === "tens" && next === "small");

const isPairedSmall = (last: WordKind | undefined, next: WordKind, value: number, current: number): boolean =>
  last === "small" && next === "small" && value >= 10 && current > 0 && current < 100;

/**
 * "two thousand three hundred nineteen" reads as "2319"; "one two" as "1 2"; an "and" no scale word precedes stays a word.
 * Paired, a two-digit number straight after a smaller one is said as digit pairs: "five thirty-one" reads "531".
 */
function readNumberRun(run: string, paired = false): string {
  const out: string[] = [];
  let total = 0, current = 0, last: WordKind | undefined;
  const flush = () => {
    if (last !== undefined) out.push(String(total + current));
    total = current = 0;
    last = undefined;
  };
  for (const word of run.toLowerCase().split(/\s+/)) {
    if (word === "and") {
      if (last !== "hundred" && last !== "scale") {
        flush();
        out.push("and");
      }
      continue;
    }
    const { kind, value } = wordValue(word);
    const pair = paired && isPairedSmall(last, kind, value, current);
    if (!pair && !continues(last, kind)) flush();
    if (kind === "hundred") current = (current || 1) * 100;
    else if (kind === "scale") {
      total += (current || 1) * value;
      current = 0;
    } else current = pair ? current * 100 + value : current + value;
    last = kind;
  }
  flush();
  return out.join(" ");
}

const MARKUP = /\[([^\]]+)\]\([^)]*\)/g;

/** A beat's text as a reader sees it: markup reduced to its word, spelled numbers written in digits. */
export const claimText = (text: string, paired = false): string =>
  text.replace(MARKUP, "$1").replace(NUMBER_RUN, (run) => readNumberRun(run, paired));

const beatTexts = (beat: ScriptBeat, paired: boolean): string[] =>
  [beat.spoken, beat.visual.assertion, ...beat.visual.labels, ...beat.visual.chips.map((chip) => chip.text)].map((text) => claimText(text, paired));

const REPO_REF = /\b([\w.-]+(?:\/[\w.-]+)?)#(\d+)\b/g;
const TASK_REF = /\b([A-Z]{2,6}-\d+)\b/g;
const PR_LIST = /\b(?:PRs?|pull[- ]requests?)\s+(#?\d+(?:(?:\s*,\s*|\s+and\s+|\s+or\s+)#?\d+)*)/gi;
const HASH_REF = /(?<![\w/])#(\d+)\b/g;

/** Pulls the named refs out of `text`, returning them and the text with each one blanked so no count reads its digits. */
function takeRefs(text: string): { refs: Claim[]; rest: string } {
  const refs: Claim[] = [];
  const rest = text
    .replace(REPO_REF, (m, repo: string, n: string) => (refs.push({ kind: "pr", text: m, n: Number(n), repo }), " REF "))
    .replace(TASK_REF, (m) => (refs.push({ kind: "task", text: m, id: m }), " REF "))
    .replace(PR_LIST, (m, list: string) => {
      for (const n of list.match(/\d+/g) ?? []) refs.push({ kind: "pr", text: `PR ${n}`, n: Number(n) });
      return " REF ";
    })
    .replace(HASH_REF, (m, n: string) => (refs.push({ kind: "pr", text: m, n: Number(n) }), " REF "));
  return { refs, rest };
}

/** The nouns a count can name, each with the test a fact must pass to be counted under it. */
const NOUNS: ReadonlyArray<{ words: RegExp; facts: RegExp; name: string }> = [
  { name: "pull request", words: /^(?:prs?|pull[- ]?requests?)$/, facts: /\bpr\b|pull[- ]request|\/pull\// },
  { name: "task", words: /^(?:tasks?|tickets?)$/, facts: /\btask\b|\b[a-z]{2,6}-\d+\b/ },
  { name: "issue", words: /^issues?$/, facts: /\bissue/ },
  { name: "session", words: /^sessions?$/, facts: /\bsession/ },
  { name: "commit", words: /^commits?$/, facts: /\bcommit/ },
  { name: "run", words: /^runs?$/, facts: /\brun\b/ },
  { name: "test", words: /^tests?$/, facts: /\btest/ },
  { name: "file", words: /^files?$/, facts: /\bfile|\bpath\b/ },
  { name: "finding", words: /^findings?$/, facts: /\bfinding/ },
  { name: "review", words: /^reviews?$/, facts: /\breview/ },
  { name: "turn", words: /^turns?$/, facts: /\bturn/ },
  { name: "release", words: /^releases?$/, facts: /\brelease/ },
];

/** A state a count may qualify its noun with, and the stem a counted fact carries. */
const QUALIFIERS: Readonly<Record<string, string>> = { open: "open", opened: "open", merged: "merg", closed: "clos", failing: "fail", failed: "fail" };
const FILLERS = new Set(["more", "other", "new", "still", "are", "is", "were", "was", "now", "already"]);

/**
 * Numbers that read as a count but are not claims about the facts, each known by the words just before it: an index
 * ("chapter 2 merged"), a year ("since 2024 merged PRs"), and a spelled "one" used as a pronoun ("which one merged").
 * Ordinals ("2nd") and lengths of time ("90 seconds") never reach this list: a count needs a known noun or state
 * right after its number.
 */
export const NOT_A_CLAIM: ReadonlyArray<{ reason: string; before: RegExp; n?: (n: number) => boolean }> = [
  { reason: "index", before: /\b(?:chapter|step|part|beat|version|v|phase|stage|slice|page|line|top)\s*$/i },
  { reason: "year", before: /\b(?:in|since|from|until|during|by|of)\s+$/i, n: (n) => n >= 1900 && n < 2100 },
  { reason: "pronoun", before: /\b(?:which|each|every|any|no|this|that)\s+$/i, n: (n) => n === 1 },
];

const isNotAClaim = (before: string, n: number): boolean => NOT_A_CLAIM.some((rule) => rule.before.test(before) && (rule.n?.(n) ?? true));

/** Reads the words after a number: fillers and states, then at most one noun; the claim ends at the last word it used. */
function readCount(n: number, words: readonly string[]): Claim | undefined {
  const qualifiers: string[] = [];
  let noun: string | undefined;
  let used = 0;
  for (const [i, word] of words.map((w) => w.toLowerCase()).entries()) {
    const named = noun ? undefined : NOUNS.find((entry) => entry.words.test(word));
    if (QUALIFIERS[word]) qualifiers.push(QUALIFIERS[word]);
    else if (named) noun = named.name;
    else if (!FILLERS.has(word)) break;
    if (QUALIFIERS[word] || named) used = i + 1;
  }
  if (!noun && qualifiers.length === 0) return undefined;
  return { kind: "count", text: [String(n), ...words.slice(0, used)].join(" "), n, ...(noun ? { noun } : {}), qualifiers };
}

const COUNT = /(?<![\w#/.-])(\d+)(?![\w.-])/g;
const FOLLOWING_WORDS = /^(?:\s+[A-Za-z-]+){0,4}/;

function takeCounts(text: string): Claim[] {
  return [...text.matchAll(COUNT)].flatMap((match) => {
    if (isNotAClaim(text.slice(0, match.index), Number(match[1]))) return [];
    const after = text.slice(match.index + match[0].length).replace(/\bpull\s+request/gi, "pull-request");
    const words = (after.match(FOLLOWING_WORDS)?.[0] ?? "").split(/\s+/).filter(Boolean);
    const claim = readCount(Number(match[1]), words);
    return claim ? [claim] : [];
  });
}

/** The claims one beat makes, spoken and on screen: named refs, then counts with a noun or a state. */
export function beatClaims(beat: ScriptBeat, paired = false): Claim[] {
  const seen = new Set<string>();
  return beatTexts(beat, paired)
    .flatMap((text) => {
      const { refs, rest } = takeRefs(text);
      return [...refs, ...takeCounts(rest)];
    })
    .filter((claim) => !seen.has(claimKey(claim)) && seen.add(claimKey(claim)));
}

const claimKey = (claim: Claim): string =>
  claim.kind === "task" ? `task:${claim.id}` : claim.kind === "pr" ? `pr:${claim.repo ?? ""}#${claim.n}` : `count:${claim.n}:${claim.noun ?? ""}:${claim.qualifiers.join(",")}`;

interface FactIndex {
  facts: readonly GatheredFact[];
  byId: ReadonlyMap<string, GatheredFact>;
  prs: ReadonlyArray<{ n: number; repo?: string; fact: string }>;
  tasks: ReadonlyArray<{ prefix: string; n: number; fact: string }>;
}

const factText = (fact: GatheredFact): string => JSON.stringify(fact).toLowerCase();
const PR_IN_FACT = /(?:([\w.-]+)#|\/pull\/|\bpr[ #-]+|pull[- ]request #?)(\d+)\b/g;
const TASK_IN_FACT = /\b([a-z]{2,6})-(\d+)\b/g;

function indexFacts(facts: readonly GatheredFact[]): FactIndex {
  const texts = facts.map((fact) => ({ fact: fact.id, text: factText(fact) }));
  return {
    facts,
    byId: new Map(facts.map((fact) => [fact.id, fact])),
    prs: texts.flatMap(({ fact, text }) => [...text.matchAll(PR_IN_FACT)].map((m) => ({ n: Number(m[2]), fact, ...(m[1] ? { repo: m[1] } : {}) }))),
    tasks: texts.flatMap(({ fact, text }) => [...text.matchAll(TASK_IN_FACT)].map((m) => ({ prefix: m[1]!, n: Number(m[2]), fact }))),
  };
}

const initials = (name: string): string => name.split(/[-_.]/).map((part) => part[0] ?? "").join("");

/** "agent-chat", "agent" and "ac" all name the repo agent-chat; an owner prefix is ignored. */
function sameRepo(named: string | undefined, gathered: string | undefined): boolean {
  if (!named) return true;
  const name = named.toLowerCase().split("/").at(-1)!;
  return gathered !== undefined && (gathered === name || gathered.startsWith(name) || initials(gathered) === name);
}

const closest = <T extends { n: number }>(items: readonly T[], n: number): T | undefined =>
  items.reduce<T | undefined>((best, item) => (!best || Math.abs(item.n - n) < Math.abs(best.n - n) ? item : best), undefined);

const nearestRef = (item: { n: number; fact: string } | undefined, what: string): string =>
  item ? `nearest gathered ${what} is in ${item.fact}` : `no gathered fact names a ${what}`;

function prVerdict(claim: { n: number; repo?: string }, index: FactIndex): string | undefined {
  const repoPrs = index.prs.filter((pr) => sameRepo(claim.repo, pr.repo));
  if (repoPrs.some((pr) => pr.n === claim.n)) return undefined;
  return nearestRef(closest(repoPrs.length ? repoPrs : index.prs, claim.n), "pull request");
}

function taskVerdict(claim: { id: string }, index: FactIndex): string | undefined {
  const [prefix = "", n = ""] = claim.id.toLowerCase().split("-");
  const same = index.tasks.filter((task) => task.prefix === prefix);
  if (same.some((task) => task.n === Number(n))) return undefined;
  return nearestRef(closest(same.length ? same : index.tasks, Number(n)), "task");
}

const STANDALONE_NUMBER = /(?<![\w#/.:-])\d+(?![\w.:-])/g;

function factValues(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (typeof value === "string") return (value.match(STANDALONE_NUMBER) ?? []).map(Number);
  if (value && typeof value === "object") return Object.values(value).flatMap(factValues);
  return [];
}

/** The facts a beat cites (its own, its why's, its user value's and its chips'); a beat that cites none reads them all. */
function citedFacts(beat: ScriptBeat, index: FactIndex): GatheredFact[] {
  const ids = [...beat.fact_ids, ...(beat.why?.fact_ids ?? []), ...(beat.user_value?.fact_ids ?? []), ...beat.visual.chips.flatMap((chip) => chip.fact_id ?? [])];
  const cited = [...new Set(ids)].flatMap((id) => index.byId.get(id) ?? []);
  return cited.length ? cited : [...index.facts];
}

type CountClaim = Extract<Claim, { kind: "count" }>;

function countVerdict(claim: CountClaim, pool: readonly GatheredFact[]): string | undefined {
  const pattern = NOUNS.find((entry) => entry.name === claim.noun)?.facts;
  const counted = pool.filter((fact) => {
    const text = factText(fact);
    return (!pattern || pattern.test(text)) && claim.qualifiers.every((stem) => text.includes(stem));
  });
  const valued = pool.flatMap((fact) => factValues(fact).map((n) => ({ n, fact: fact.id })));
  if (counted.length === claim.n || valued.some((v) => v.n === claim.n)) return undefined;
  const label = [claim.noun ?? "fact", ...claim.qualifiers].join(", ");
  const near = closest(valued, claim.n);
  const value = near ? `; nearest value ${near.n} is in ${near.fact}` : "";
  return `the cited facts count ${counted.length} (${label})${counted.length ? `: ${counted.map((f) => f.id).join(", ")}` : ""}${value}`;
}

function verdict(claim: Claim, beat: ScriptBeat, index: FactIndex): string | undefined {
  if (claim.kind === "pr") return prVerdict(claim, index);
  if (claim.kind === "task") return taskVerdict(claim, index);
  return countVerdict(claim, citedFacts(beat, index));
}

function beatFindings(beat: ScriptBeat, index: FactIndex, paired: boolean): ClaimFinding[] {
  return beatClaims(beat, paired).flatMap((claim) => {
    const nearest = verdict(claim, beat, index);
    return nearest === undefined ? [] : [{ beat: beat.id, claim: claim.text, nearest }];
  });
}

/**
 * Every claim in the script that the gathered facts do not back, one finding per beat and claim. A beat is read two ways,
 * numbers said apart ("twenty-three thirty-nine" as 23 and 39) and said in pairs (2339); it is backed when either is.
 */
export function claimFindings(script: ScriptV1, facts: readonly GatheredFact[]): ClaimFinding[] {
  const index = indexFacts(facts);
  return script.beats.flatMap((beat) => {
    const apart = beatFindings(beat, index, false);
    if (apart.length === 0) return [];
    const paired = beatFindings(beat, index, true);
    return paired.length < apart.length ? paired : apart;
  });
}

export const findingLine = ({ beat, claim, nearest }: ClaimFinding): string => `${beat} "${claim}" (${nearest})`;

/**
 * Q-E20: each named pull request or task, and each count, matches the gathered facts. A script checked without facts
 * gets a passing warning row that says the check did not run, since L0 rows have no info level.
 */
export function claimsCheckWith(facts?: readonly GatheredFact[]): L0Check {
  return ({ script }): L0Result[] => {
    if (!facts?.length) return [ruleRow(CLAIMS_CHECK_ID, { value: 0, threshold: 0, pass: true, severity: "warning", mode: "tagged" })];
    const findings = claimFindings(script, facts);
    return [ruleRow(CLAIMS_CHECK_ID, { value: findings.length, threshold: 0, pass: findings.length === 0, beats: findings.map((f) => f.beat) })];
  };
}

/** The registered default: no facts reach the shared L0 pass, so it reports the skip; a gathered run passes its facts. */
export const claimsCheck: L0Check = claimsCheckWith();

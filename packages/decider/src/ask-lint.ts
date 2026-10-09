/**
 * The AskUserQuestion contract as a pure lint. An owner question must be one decision (AQ1), name
 * what each id is (AQ2), say what holds today (AQ3), carry its substance rather than point at a
 * file (AQ4) and lead with a recommendation (AQ5). No model call: every rule is a text pattern, and
 * each finding's evidence names the trigger it matched so a false positive is easy to see.
 */

export const ASK_RULES = ["AQ1", "AQ2", "AQ3", "AQ4", "AQ5"] as const;
export type AskRule = (typeof ASK_RULES)[number];

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  header?: string;
  question: string;
  options?: readonly AskOption[];
  recommended?: string | null;
}

/** One broken rule; other lints of owner-facing text (`lintPrSection`) reuse it with their own rule ids. */
export interface AskFinding<Rule extends string = AskRule> {
  rule: Rule;
  evidence: string;
}

/** One item of a Morning list or a plan's owner questions, with its findings. */
export interface AskItemFindings {
  /** The item's own id as written: `vc-65.1`, `ws-9, A1`, or a plan entry's number. */
  id: string;
  text: string;
  findings: AskFinding[];
}

/** A sub-item suffix stays part of the id, so `VW-65.1` is never read as `VW-65` or `VW-651`. */
const ID_TOKEN = /\b[A-Z]{1,4}-\d+(?:\.\d+)?\b|\b\w+#\d+\b|\b[QD]\d+\b|\b[Ii]tem \d+\b/g;
const ID_IN_WORD = new RegExp(ID_TOKEN.source);
/** `(?<!\w)` anchors `\w*#` so a long word-run is scanned once, not from every offset. */
const RANGE_END = String.raw`(?:\b[A-Z]{1,4}-\d+|(?<!\w)\w*#\d+|\b[QD]\d+)`;
const ID_RANGE = new RegExp(String.raw`${RANGE_END}\s*(?:to|through|-|–)\s*${RANGE_END}\b`);
/** The lookbehind keeps an id's or a date's digits ("VW-258 defaults", "10-03 calls") from reading as a count. */
const QUESTION_COUNT = /(?<![\w.-])\d+ (?:Qs|questions|items|calls|defaults)\b/i;
const QD_TOKEN = /\b[QD]\d+\b/g;
const BACKTICK_SPAN = /`[^`]*`/g;
const URL = /\bhttps?:\/\/\S+/g;
/** Both path patterns start at a token edge, which keeps them linear; a capitalised bare `Name.js` is a product ("Node.js"). */
const FILE_PATH = /(?<![\w.@~/-])(?![A-Z]\w*\.js\b)(?:[~.]*\/)?(?:[\w.@-]+\/)*[\w@-]+\.(?:md|mdx|ts|tsx|js|mjs|cjs|json|ya?ml|sh|py|txt|toml)\b/g;
/** Rooted by `/`, `~/` or `./`; "left/right/center" is a slash-separated list, not a path. */
const ROOTED_PATH = /(?<![\w.@~/-])(?:~|\.{1,2})?\/[\w.@-]+\/[\w.@/-]+/g;
const PR_BODY = /\bPR body\b/i;
const NOW_MARKER = /\bNow:/;
const COVERED_ENUMERATOR = /(?<!\w)\((?:[a-z]|\d{1,2})\)/g;
const ASK_WORDS = new Set(["ok", "accept", "recommend", "recommended", "yes", "no", "default", "defaults"]);
const FUNCTION_WORDS = new Set(
  ("a an the and or but nor of in on at to for from by with as into onto than then so if " +
    "is are was were be been it its this that these those there here you your we our i me my they them " +
    "any all each may can will would should do does did has have had not").split(" "),
);
const ID_WINDOW = 4;
/** Context is read from a bounded slice, so each id costs the same however long the text is. */
const ID_WINDOW_CHARS = 400;
const MIN_ID_CONTEXT = 3;
const MIN_POINTER_WORDS = 12;
const DEFAULTS_REACH = 4;

function plainText(text: string): string {
  return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/** Spans whose words never count: code, URLs and paths. */
function masked(text: string): string {
  return [BACKTICK_SPAN, URL, FILE_PATH, ROOTED_PATH].reduce((acc, pattern) => acc.replace(pattern, " "), text);
}

function bareWord(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, "");
}

function isContentWord(token: string): boolean {
  const word = bareWord(token);
  return /\p{L}/u.test(word) && !ASK_WORDS.has(word) && !FUNCTION_WORDS.has(word);
}

function contentWords(text: string): string[] {
  return masked(text).replace(ID_TOKEN, " ").split(/\s+/).filter(isContentWord);
}

function isCommandItem(text: string): boolean {
  return text.includes("`!") || /^recommend run\b/i.test(text);
}

function isPrinciple(text: string): boolean {
  return /^principle:/i.test(text);
}

function defaultsNearAccept(text: string): string | null {
  const words = text.split(/\s+/).map(bareWord);
  for (const [i, word] of words.entries()) {
    if (word !== "defaults") continue;
    const near = words.slice(Math.max(0, i - DEFAULTS_REACH), i + DEFAULTS_REACH + 1);
    const verb = near.find((w) => w === "ok" || w.startsWith("accept") || w.startsWith("recommend"));
    if (verb) return `"defaults" within ${DEFAULTS_REACH} words of "${verb}"`;
  }
  return null;
}

function batchTriggers(text: string, options: readonly AskOption[]): string[] {
  const triggers: string[] = [];
  const range = ID_RANGE.exec(text);
  if (range) triggers.push(`id range "${range[0]}"`);
  const count = QUESTION_COUNT.exec(text);
  if (count) triggers.push(`question count "${count[0]}"`);
  const defaults = defaultsNearAccept(text);
  if (defaults) triggers.push(defaults);
  for (const option of options) {
    if (/^(?:accept|ok) all\b/i.test(option.label.trim())) triggers.push(`option "${option.label}"`);
  }
  const qd = [...new Set(text.match(QD_TOKEN) ?? [])];
  if (qd.length >= 3) triggers.push(`${qd.length} distinct Q/D ids (${qd.join(", ")})`);
  return triggers;
}

function principleTriggers(text: string): string[] {
  const covered = new Set(text.match(COVERED_ENUMERATOR) ?? []).size;
  return covered >= 2 ? [] : [`Principle: lists ${covered} covered items, needs 2 or more`];
}

/** Test hook: lets a test assert how much text the id-context windows read, instead of timing the lint. */
export interface AskLintStats {
  windowChars: number;
}

function wordsAround(text: string, start: number, end: number, stats?: AskLintStats): string[] {
  const beforeText = text.slice(Math.max(0, start - ID_WINDOW_CHARS), start);
  const afterText = text.slice(end, end + ID_WINDOW_CHARS);
  if (stats) stats.windowChars += beforeText.length + afterText.length;
  const before = beforeText.split(/\s+/).filter(Boolean).slice(-ID_WINDOW);
  const after = afterText.split(/\s+/).filter(Boolean).slice(0, ID_WINDOW);
  return [...before, ...after].filter((token) => !ID_IN_WORD.test(token) && isContentWord(token));
}

function bareIdTriggers(text: string, stats?: AskLintStats): string[] {
  const body = masked(text);
  const matches = [...body.matchAll(ID_TOKEN)];
  const counts = new Map<string, number>();
  for (const m of matches) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  const triggers: string[] = [];
  for (const match of matches) {
    if ((counts.get(match[0]) ?? 0) > 1) continue;
    const context = wordsAround(body, match.index, match.index + match[0].length, stats).length;
    if (context < MIN_ID_CONTEXT) triggers.push(`bare id ${match[0]} (${context} content words nearby)`);
  }
  return triggers;
}

function bareOptionTriggers(options: readonly AskOption[]): string[] {
  return options
    .filter((o) => o.label.trim().split(/\s+/).length <= 2 && !/^(?:yes|no)$/i.test(o.label.trim()))
    .filter((o) => (o.description ?? "").trim().split(/\s+/).filter(Boolean).length < 4)
    .map((o) => `option "${o.label}" has a description under 4 words`);
}

function pointerTrigger(text: string): string | null {
  const pointer = text.match(URL)?.[0] ?? text.match(FILE_PATH)?.[0] ?? text.match(ROOTED_PATH)?.[0] ?? text.match(PR_BODY)?.[0];
  if (!pointer) return null;
  const words = contentWords(text).length;
  return words < MIN_POINTER_WORDS ? `points at "${pointer}" with ${words} content words` : null;
}

function firstSentence(text: string): string {
  return text.split(/[.?!](?:\s|$)/)[0] ?? "";
}

function recommends(question: AskQuestion, text: string): boolean {
  if (question.recommended) return true;
  if ((question.options ?? []).some((o) => /\(recommended\)\s*$/i.test(o.label))) return true;
  return /recommend/i.test(firstSentence(text));
}

function finding(rule: AskRule, triggers: readonly string[]): AskFinding[] {
  return triggers.length > 0 ? [{ rule, evidence: triggers.join("; ") }] : [];
}

/** Every contract rule the question breaks, in rule order; an empty list means it passes. */
export function lintAsk(question: AskQuestion, stats?: AskLintStats): AskFinding[] {
  const text = plainText(question.question);
  const options = question.options ?? [];
  const command = isCommandItem(text);
  const batch = isPrinciple(text) ? principleTriggers(text) : batchTriggers(text, options);
  const pointer = command ? null : pointerTrigger(text);
  return [
    ...finding("AQ1", batch),
    ...finding("AQ2", [...bareIdTriggers(text, stats), ...bareOptionTriggers(options)]),
    ...finding("AQ3", command || NOW_MARKER.test(text) ? [] : ["no Now: marker"]),
    ...finding("AQ4", pointer ? [pointer] : []),
    ...finding("AQ5", recommends(question, text) ? [] : ["no recommendation in the first sentence"]),
  ];
}

interface RawItem {
  id: string;
  lines: string[];
}

/** Items open on an unindented header line; indented lines continue the open item, anything else closes it. */
function splitItems(lines: readonly string[], header: (line: string) => { id: string; text: string } | null): RawItem[] {
  const items: RawItem[] = [];
  let open: RawItem | null = null;
  for (const line of lines) {
    const opened = header(line);
    if (opened) items.push((open = { id: opened.id, lines: [opened.text] }));
    else if (open && /^\s+\S/.test(line)) open.lines.push(line.trim());
    else open = null;
  }
  return items;
}

function lintItems(items: readonly RawItem[]): AskItemFindings[] {
  return items.map(({ id, lines }) => {
    const text = lines.join(" ");
    return { id, text, findings: lintAsk({ question: text }) };
  });
}

function morningHeader(line: string): { id: string; text: string } | null {
  const match = /^\[([^\]]+)\]\s+(.*)$/.exec(line) ?? /^(\d+)\.\s+(.*)$/.exec(line);
  return match ? { id: match[1] ?? "", text: match[2] ?? "" } : null;
}

/** Lints each `[id]` or `N.` item of a Morning list, the item's own id excluded from its text. */
export function lintMorningList(text: string): AskItemFindings[] {
  return lintItems(splitItems(text.split("\n"), morningHeader));
}

function entryHeader(line: string): { id: string; text: string } | null {
  const match = /^(\d+)\.\s+(.*)$/.exec(line) ?? /^[-*]\s+(.*)$/.exec(line);
  if (!match) return null;
  return match.length === 3 ? { id: match[1] ?? "", text: match[2] ?? "" } : { id: "", text: match[1] ?? "" };
}

function ownerQuestionSections(lines: readonly string[]): string[][] {
  const sections: string[][] = [];
  let level = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading && level > 0 && (heading[1] ?? "").length <= level) level = 0;
    if (heading && /owner questions/i.test(heading[2] ?? "")) {
      level = (heading[1] ?? "").length;
      sections.push([]);
    } else if (level > 0) sections.at(-1)?.push(line);
  }
  return sections;
}

/** Lints each entry of every "Owner questions" section of a plan; an unnumbered bullet gets its position as its id. */
export function lintOwnerQuestions(planText: string): AskItemFindings[] {
  const items = ownerQuestionSections(planText.split("\n")).flatMap((section) => splitItems(section, entryHeader));
  return lintItems(items.map((item, index) => (item.id === "" ? { ...item, id: String(index + 1) } : item)));
}

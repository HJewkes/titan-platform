import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { classifyQuestion } from "./classify.js";
import type { LedgerRowWire } from "./ledger.js";
import { classifyOutcome } from "./outcome.js";
import type { LedgerSource, SourceCandidate, SourceRead, SourceWatermark, SourceWatermarks } from "./source.js";

/**
 * The Morning owner-answers source. A day's `<date>.md` lists numbered items, each opening with a
 * recommendation; `<date>-owner-answers.md` answers them by item number. An answer joins to its item
 * by number alone. A line with no readable number is counted, and so is a number that names no item
 * or more than one: a join is never guessed.
 */

export const MORNING_SOURCE = "morning";

const ANSWERS_SUFFIX = "-owner-answers.md";
const BRACKET_ITEM = /^\[([^\]]+)\]\s+(.*)$/;
const NUMBERED_ITEM = /^(\d+)\.\s+(.*)$/;
const ANSWER_LINE = /^([A-Za-z]{1,3}-?\s?)?(\d+(?:\s*[/,]\s*\d+)*)(?:\s*:\s*|\s+|(?=[,&+/]\s*[A-Za-z]{0,3}\s?\d))(.+)$/;
const RECOMMENDATION = /\brecommend(?:ed)?\b[^.]*/i;
const AFFIRMATIVE = /^(?:yes|accept(?:ed)?|keep|go|approve[d]?|ok|agreed)\b(?![^,.;:]*\bnot\b)/i;
const HEDGE = /\b(?:but|however|instead|hold|wait|except|unless)\b/i;
const MORE_ITEMS = /^(?:(?:and|&|\+|,|\/)\s*[a-z]{0,3}\s?\d|\d+\s*:)/i;

export interface MorningItem {
  /** The ids the list gives the item, normalized: `hs-25` is `hs25`, `A5` is `a5`, `30.` is `30`. */
  ids: string[];
  question: string;
  recommended: string | null;
}

export interface MorningAnswer {
  /** One normalized id per number the line names; a bare number stays a bare number. */
  ids: string[];
  text: string;
  /** Where the line starts in the answers file. */
  byteOffset: number;
  /** The text goes on to name more items ("1 and 2: yes"), so one answer cannot be assigned to one. */
  namesMore: boolean;
}

export interface ParsedAnswerLines {
  answers: MorningAnswer[];
  unparseable: number;
}

export interface MorningCounts {
  unparseable: number;
  /** Answer ids that name no item in the day's list. */
  unmatched: number;
  /** Bare answer numbers that fit more than one item. */
  ambiguous: number;
  /** Answers whose id an earlier line in the same file already answered, under any id of the item; the first stands. */
  duplicate: number;
}

export interface MorningJoin {
  rows: LedgerRowWire[];
  /** The item each row answers, aligned by index with `rows`. */
  items: MorningItem[];
  counts: MorningCounts;
}

export interface MorningFileSystem {
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<Buffer>;
}

export type MorningDayCounts = MorningCounts & {
  /** Rows that did not get exactly one initiative. */
  unresolved: number;
};

/** Every initiative the item names; empty when it names none. */
export type MorningInitiativeResolver = (item: MorningItem) => readonly string[] | Promise<readonly string[]>;

export interface MorningSourceOptions {
  /** The directory holding `<date>.md` and `<date>-owner-answers.md` pairs. */
  dir: string;
  fs?: MorningFileSystem;
  /** Absent: every row stays unclaimed. A throw leaves the day unread and reported in errors. */
  resolveInitiatives?: MorningInitiativeResolver;
  /** Receives each answers file's counts as it is read. */
  onCounts?: (date: string, counts: MorningDayCounts) => void;
}

const TASK_ID = /\b[A-Z]{1,4}-\d+\b/g;

/** Task ids in text, in order, deduplicated. */
export function taskIdsIn(text: string): string[] {
  return [...new Set(text.match(TASK_ID) ?? [])];
}

/** A resolver from an id lookup: the union of lookup(id) over the task ids in the item's question. */
export function initiativesOfTaskIds(lookup: (taskId: string) => readonly string[]): MorningInitiativeResolver {
  return (item) => [...new Set(taskIdsIn(item.question).flatMap((id) => lookup(id)))];
}

const nodeFs: MorningFileSystem = { readdir: (dir) => readdir(dir), readFile: (file) => readFile(file) };

function normalizeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sentenceCase(text: string): string {
  return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function itemOf(ids: string[], header: string): MorningItem {
  const question = sentenceCase(header);
  const match = RECOMMENDATION.exec(question);
  return { ids, question, recommended: match ? match[0].replace(/[\s:]+$/, "") : null };
}

function headerOf(line: string): { ids: string[]; text: string } | null {
  const bracket = BRACKET_ITEM.exec(line);
  if (bracket) return { ids: (bracket[1] ?? "").split(",").map(normalizeId).filter(Boolean), text: bracket[2] ?? "" };
  const numbered = NUMBERED_ITEM.exec(line);
  return numbered ? { ids: [numbered[1] ?? ""], text: numbered[2] ?? "" } : null;
}

/** Items start at an unindented `[id]` or `N.` line; indented lines and anything else are not items. */
export function parseMorningList(text: string): MorningItem[] {
  const items: MorningItem[] = [];
  for (const line of text.split("\n")) {
    const header = headerOf(line);
    if (header && header.ids.length > 0) items.push(itemOf(header.ids, header.text));
  }
  return items;
}

function answerIds(prefix: string | undefined, numbers: string): string[] {
  const letters = normalizeId(prefix ?? "");
  return numbers.split(/[/,]/).map((n) => `${letters}${n.trim()}`);
}

/** Answer lines are `<ids>: <text>` or `<ids> <text>`; headings, blanks and lines with no leading number are skipped or counted. */
export function parseOwnerAnswers(text: string): ParsedAnswerLines {
  const answers: MorningAnswer[] = [];
  let unparseable = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += Buffer.byteLength(line) + 1;
    if (line.trim() === "" || line.startsWith("#")) continue;
    const match = ANSWER_LINE.exec(line);
    if (!match) unparseable += 1;
    else {
      const text = (match[3] ?? "").trim();
      answers.push({ ids: answerIds(match[1], match[2] ?? ""), text, byteOffset: start, namesMore: MORE_ITEMS.test(text) });
    }
  }
  return { answers, unparseable };
}

type Lookup = { item: MorningItem } | { ambiguous: true } | null;

function lookup(items: readonly MorningItem[], id: string): Lookup {
  const fits = items.filter((item) => item.ids.includes(id));
  if (fits.length === 0) return null;
  return fits.length === 1 && fits[0] ? { item: fits[0] } : { ambiguous: true };
}

/** An unhedged affirmative lead word takes the recommendation; anything else keeps the owner's words. */
function scoredAnswer(item: MorningItem, text: string): string {
  const accepts = AFFIRMATIVE.test(text) && !HEDGE.test(text);
  return item.recommended !== null && accepts ? item.recommended : text;
}

function rowFor(item: MorningItem, id: string, answer: MorningAnswer, date: string, answersPath: string): LedgerRowWire {
  const scored = scoredAnswer(item, answer.text);
  return {
    key: `morning:${date}/${id}`,
    v: 2,
    source: "morning",
    asked_at: date,
    answered_at: date,
    locator: { path: answersPath, byteOffset: answer.byteOffset },
    initiative: null,
    category: classifyQuestion({ header: "", question: item.question, options: [] }),
    header: null,
    question: item.question,
    options: [],
    recommended: item.recommended,
    answer: answer.text,
    outcome: classifyOutcome({ answer: scored, options: [], recommended: item.recommended }),
  };
}

/** Pure join of one day's list and answers; counts say what was left out and why. A bare number joins only a bare-numbered item. */
export function joinMorning(date: string, listText: string, answersText: string, answersPath: string): MorningJoin {
  const items = parseMorningList(listText);
  const { answers, unparseable } = parseOwnerAnswers(answersText);
  const rows: LedgerRowWire[] = [];
  const joined: MorningItem[] = [];
  const counts: MorningCounts = { unparseable, unmatched: 0, ambiguous: 0, duplicate: 0 };
  const answered = new Set<MorningItem>();
  for (const answer of answers) {
    if (answer.namesMore) {
      counts.ambiguous += 1;
      continue;
    }
    for (const id of answer.ids) {
      const found = lookup(items, id);
      if (found === null) counts.unmatched += 1;
      else if ("ambiguous" in found) counts.ambiguous += 1;
      else if (answered.has(found.item)) counts.duplicate += 1;
      else {
        answered.add(found.item);
        rows.push(rowFor(found.item, id, answer, date, answersPath));
        joined.push(found.item);
      }
    }
  }
  return { rows, items: joined, counts };
}

function watermarkOf(bytes: Buffer): SourceWatermark {
  return { offset: bytes.length, prefixHash: createHash("sha256").update(bytes).digest("hex") };
}

async function resolveRows(options: MorningSourceOptions, join: MorningJoin): Promise<SourceCandidate[]> {
  const resolve = options.resolveInitiatives;
  const candidates: SourceCandidate[] = [];
  for (const [index, row] of join.rows.entries()) {
    const mentioned = resolve && join.items[index] ? await resolve(join.items[index]) : [];
    const only = mentioned.length === 1 ? (mentioned[0] ?? null) : null;
    candidates.push({ row: { ...row, initiative: only }, cwd: null, mentionedInitiatives: mentioned });
  }
  return candidates;
}

async function readDay(options: MorningSourceOptions, filename: string, since: SourceWatermarks, out: SourceRead): Promise<void> {
  const fs = options.fs ?? nodeFs;
  const date = filename.slice(0, -ANSWERS_SUFFIX.length);
  const answersPath = path.join(options.dir, filename);
  const answers = await fs.readFile(answersPath);
  const watermark = watermarkOf(answers);
  const seen = since.get(filename);
  if (seen && seen.offset === watermark.offset && seen.prefixHash === watermark.prefixHash) return;
  const list = await fs.readFile(path.join(options.dir, `${date}.md`));
  const join = joinMorning(date, list.toString("utf8"), answers.toString("utf8"), answersPath);
  const candidates = await resolveRows(options, join);
  out.watermarks.set(filename, watermark);
  out.candidates.push(...candidates);
  const unresolved = candidates.filter((c) => c.row.initiative === null).length;
  options.onCounts?.(date, { ...join.counts, unresolved });
}

/** One cursor per answers file; a day whose list is missing is reported and retried, never joined blind. */
export function morningSource(options: MorningSourceOptions): LedgerSource {
  return {
    name: MORNING_SOURCE,
    async read(since: SourceWatermarks): Promise<SourceRead> {
      const out: SourceRead = { candidates: [], watermarks: new Map(), pending: 0, errors: [] };
      const names = await (options.fs ?? nodeFs).readdir(options.dir);
      for (const filename of names.filter((n) => n.endsWith(ANSWERS_SUFFIX)).sort()) {
        try {
          await readDay(options, filename, since, out);
        } catch (err) {
          out.errors.push(`${path.join(options.dir, filename)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return out;
    },
  };
}

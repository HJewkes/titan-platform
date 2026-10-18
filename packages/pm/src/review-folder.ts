import { readTsv } from "./tsv.js";

/** How urgent a judged topic is, most urgent first. */
export const TOPIC_PRIORITIES = ["P1", "P2", "P3", "P4"] as const;

/** How titan compares with the reviewed repo on a topic, as the judge writes it. */
export const TOPIC_VERDICTS = [
  "missing",
  "have-worse",
  "lost",
  "ported-partial",
  "ported",
  "have-better",
  "already-have",
  "dropped-on-purpose",
  "never-worked",
  "out-of-scope",
] as const;

export type TopicPriority = (typeof TOPIC_PRIORITIES)[number];
export type TopicVerdict = (typeof TOPIC_VERDICTS)[number];

const TOPIC_COLUMNS = ["topic_id", "tier", "title", "verdict", "priority", "titan_evidence", "reason"] as const;
const CLAIM_COLUMNS = ["id", "source", "status", "evidence", "claim"] as const;
const RUN_COLUMNS = ["total_cost_usd", "is_error", "ts"] as const;

type TopicColumn = (typeof TOPIC_COLUMNS)[number];
type ClaimColumn = (typeof CLAIM_COLUMNS)[number];

/**
 * One row of `topics-judged.tsv`. Verdict and priority stay plain strings so a review that
 * coins a new verdict still parses; compare them against the vocabularies where it matters.
 */
export type TopicRow = Record<TopicColumn, string> & {
  /** 1-based line in the file. */
  line: number;
  /** Every column beyond the common seven, which differ between review generations. */
  extra: Record<string, string>;
};

/** One row of `claims-audit.tsv`. The optional columns are absent when the header lacks them. */
export type ClaimRow = Record<ClaimColumn, string> & {
  line: number;
  basis?: string;
  note?: string;
  wave?: string;
};

/** Headless spend of a review, from `runs.tsv`. Agent sessions are not in that file. */
export interface RunCost {
  usd: number;
  calls: number;
  errors: number;
  /** The latest `ts`, or null when no row has one. */
  lastTs: string | null;
}

/** Parses `topics-judged.tsv`. Throws, naming `file`, when a common column is missing. */
export function parseTopicsJudged(tsv: string, file = "topics-judged.tsv"): TopicRow[] {
  const common: ReadonlySet<string> = new Set(TOPIC_COLUMNS);
  return readTsv(tsv, TOPIC_COLUMNS, file).map(({ line, fields }) => {
    const { topic_id = "", tier = "", title = "", verdict = "", priority = "", titan_evidence = "", reason = "" } = fields;
    const extra = Object.fromEntries(Object.entries(fields).filter(([column]) => !common.has(column)));
    return { line, topic_id, tier, title, verdict, priority, titan_evidence, reason, extra };
  });
}

/** Parses `claims-audit.tsv`. Throws, naming `file`, when a required column is missing. */
export function parseClaimsAudit(tsv: string, file = "claims-audit.tsv"): ClaimRow[] {
  return readTsv(tsv, CLAIM_COLUMNS, file).map(({ line, fields }) => {
    const { id = "", source = "", status = "", evidence = "", claim = "", basis, note, wave } = fields;
    return { line, id, source, status, evidence, claim, ...defined({ basis, note, wave }) };
  });
}

function defined(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The header bullets of a review's README.md. Every key is optional; older READMEs omit some. */
export interface ReviewPin {
  remote?: string;
  /** The pinned commit, short or full, without the date and subject that often follow it. */
  head?: string;
  /** Free text written when the README was, often stale; never derive a review's state from it. */
  status?: string;
  pinned?: string;
  mode?: string;
  focus?: string;
}

const PIN_KEYS: ReadonlySet<string> = new Set(["remote", "head", "status", "pinned", "mode", "focus"]);
const PIN_BULLET = /^\s*[-*]\s+([A-Za-z]+):\s*(.*?)\s*$/;
const LEADING_SHA = /^([0-9a-f]{7,40})\b/;
const LEADING_URL = /^(\S+:\/\/\S+)/;

/**
 * Reads the `- key: value` bullets of a review README. Keys match in any case (`Remote:` and
 * `remote:` both occur), and the first bullet for a key wins. HEAD keeps only its leading
 * hash, and remote only its leading URL when it starts with one.
 */
export function readReviewPin(readme: string): ReviewPin {
  const pin: Record<string, string> = {};
  for (const text of readme.split(/\r?\n/)) {
    const match = PIN_BULLET.exec(text);
    const key = match?.[1]?.toLowerCase();
    if (key === undefined || !PIN_KEYS.has(key) || key in pin) continue;
    pin[key] = trimPinValue(key, match?.[2] ?? "");
  }
  return pin;
}

function trimPinValue(key: string, value: string): string {
  if (key === "head") return LEADING_SHA.exec(value)?.[1] ?? value;
  if (key === "remote") return LEADING_URL.exec(value)?.[1] ?? value;
  return value;
}

/** Sums `runs.tsv`. An empty cost counts as zero; any other non-number throws, naming its line. */
export function sumRunCost(tsv: string, file = "runs.tsv"): RunCost {
  const cost: RunCost = { usd: 0, calls: 0, errors: 0, lastTs: null };
  for (const { line, fields } of readTsv(tsv, RUN_COLUMNS, file)) {
    const usd = Number(fields.total_cost_usd ?? "");
    if (!Number.isFinite(usd)) throw new Error(`${file}:${line}: total_cost_usd is not a number`);
    cost.usd += usd;
    cost.calls += 1;
    if (fields.is_error === "true") cost.errors += 1;
    const ts = fields.ts ?? "";
    if (ts !== "" && (cost.lastTs === null || ts > cost.lastTs)) cost.lastTs = ts;
  }
  return cost;
}

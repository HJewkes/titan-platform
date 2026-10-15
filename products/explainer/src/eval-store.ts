import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Hex characters kept from a sha256, the bench's short artifact id. */
export const SHORT_SHA_LENGTH = 12;

const byCodePoint = (a: string, b: string): number => {
  const [x, y] = [[...a], [...b]];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
};

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * The bench's canonical JSON: keys sorted by code point, no whitespace, undefined members dropped.
 * It matches Python's `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`,
 * which minted the pilot's existing shas, for every value that has been through `JSON.parse`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || !isPlainObject(value)) throw new TypeError(`canonical JSON accepts only JSON-safe values, got ${String(value)}`);
  const members = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${members.join(",")}}`;
}

const shortSha = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex").slice(0, SHORT_SHA_LENGTH);

/** The first 12 hex of sha256 over a value's canonical JSON, UTF-8. */
export const canonicalSha = (value: unknown): string => shortSha(canonicalJson(value));

/** Names a script artifact by its canonical JSON. */
export const scriptSha = canonicalSha;

/** Names a rule registry version by its file bytes, so a reworded rule never mixes with old rows. */
export const rulesSha = (registry: string | Uint8Array): string => shortSha(registry);

/** Where one bench keeps its eval rows and frozen scripts. */
export interface BenchLayout {
  evals: string;
  scripts: string;
  runs: string;
  structure: string;
}

export function benchLayout(benchDir: string): BenchLayout {
  const evals = join(benchDir, "evals");
  return {
    evals,
    scripts: join(benchDir, "scripts"),
    runs: join(evals, "runs.jsonl"),
    structure: join(evals, "structure.tsv"),
  };
}

/** A frozen script carries its lineage, so every eval row resolves to the exact text it scored. */
export interface FrozenScript {
  script_sha: string;
  parent_sha: string | null;
  script: unknown;
}

/** Freezes a script under its sha and returns the sha. A copy already frozen is never rewritten. */
export function freezeScript(layout: BenchLayout, script: unknown, parentSha: string | null): string {
  const sha = scriptSha(script);
  const path = join(layout.scripts, `${sha}.json`);
  if (existsSync(path)) return sha;
  const frozen: FrozenScript = { script_sha: sha, parent_sha: parentSha, script };
  mkdirSync(layout.scripts, { recursive: true });
  writeFileSync(path, `${JSON.stringify(frozen, null, 2)}\n`);
  return sha;
}

export const STRUCTURE_COLUMNS = [
  "config_id",
  "script_sha",
  "rules_sha",
  "check_id",
  "mode",
  "severity",
  "value",
  "threshold",
  "pass",
  "detail_beats",
] as const;

/** One L0 check's result on one script, a row of `structure.tsv`. */
export interface StructureRow {
  config_id: string;
  script_sha: string;
  rules_sha: string;
  check_id: string;
  mode: "tagged" | "heuristic";
  severity: "error" | "warning";
  value: number;
  threshold: number;
  pass: boolean;
  detail_beats: string[];
}

const tsvCell = (value: unknown): string => {
  const text = Array.isArray(value) ? value.join(",") : String(value);
  return text.replace(/[\t\r\n]+/g, " ");
};

/** Appends rows, writing the header to a new file. A file whose header differs is refused, not mixed. */
export function appendTsv<T extends object>(path: string, columns: readonly (keyof T & string)[], rows: readonly T[]): void {
  const header = columns.join("\t");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").split("\n", 1)[0];
    if (existing !== header) throw new Error(`${path} has columns "${existing}", expected "${header}"`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${header}\n`);
  }
  const lines = rows.map((row) => columns.map((column) => tsvCell(row[column])).join("\t"));
  if (lines.length > 0) appendFileSync(path, `${lines.join("\n")}\n`);
}

/** Reads a header-first TSV into records; list cells are comma-separated. */
export function readTsv(path: string): Record<string, string>[] {
  const [header, ...lines] = readFileSync(path, "utf8").trimEnd().split("\n");
  const columns = (header ?? "").split("\t");
  return lines.map((line) => Object.fromEntries(line.split("\t").map((cell, i) => [columns[i], cell])));
}

/** One eval invocation, a line of `runs.jsonl`. L0 runs cost nothing and have no judge. */
export interface RunRecord {
  config_id: string;
  script_sha: string;
  parent_sha: string | null;
  rules_sha: string;
  eval_id: string;
  eval_version: string;
  judge: string | null;
  run: number;
  batch_id: string | null;
  usd: number;
  tokens_in: number;
  tokens_out: number;
  wall_s: number;
  started_at: string;
}

export function appendRun(layout: BenchLayout, record: RunRecord): void {
  mkdirSync(layout.evals, { recursive: true });
  appendFileSync(layout.runs, `${JSON.stringify(record)}\n`);
}

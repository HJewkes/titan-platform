import { parseIntentDigest } from "@titan-design/pm";
import { parse as parseYaml, YAMLError } from "yaml";
import { z } from "zod";
import { BetBlockSchema, FrontMatterSchema, OutcomeBlockSchema, type BetBlock, type OutcomeBlock, type SheetFrontMatter } from "./bet-sheet-schema.js";

/*
 * Reads a `titan-bet-sheet/v1` file (TP-5755 PLAN 5.3): front matter, one `outcome:` block and the `bet:` blocks in
 * proposed order. Pure; strict about every block, and blind to the prose between blocks, which is for the owner.
 */

interface SheetError {
  line: number;
  message: string;
}

export interface SheetBet extends BetBlock {
  /** `<initiative>/<local>`: the sheet's own name for the bet, never a plan-store id. */
  id: string;
  outcome: string;
  /** 1-based lines of the block's `bet:` key and of its `cites`, for errors found after the block parsed. */
  line: number;
  citesLine: number;
}

export interface BetSheet {
  front: SheetFrontMatter;
  outcome: OutcomeBlock & { id: string };
  bets: SheetBet[];
}

/** What the front matter says about where the sheet applies, read even when the sheet fails, so a failure reaches the right lane. */
export interface SheetScope {
  initiative?: string;
  lane?: string | null;
  week?: string;
}

export type BetSheetResult = { ok: true; sheet: BetSheet } | { ok: false; errors: SheetError[]; scope: SheetScope };

/** The text of `<digestDir>/<name>.md`, or undefined when there is none. */
type DigestText = (name: string) => string | undefined;

interface Block {
  key: string;
  value: unknown;
  /** 1-based line of the opening fence. */
  line: number;
  rows: string[];
}

const FENCE = /^```(\S*)\s*$/;

function yamlValue(text: string, firstLine: number, errors: SheetError[]): unknown {
  try {
    return parseYaml(text) as unknown;
  } catch (error) {
    const at = error instanceof YAMLError ? (error.linePos?.[0]?.line ?? 1) : 1;
    errors.push({ line: firstLine + at - 1, message: `not YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` });
    return undefined;
  }
}

/** The line in `rows` of the deepest key on the issue's path, so an error points at the field and not the block. */
function lineOf(rows: readonly string[], firstLine: number, path: readonly PropertyKey[]): number {
  for (const key of [...path].reverse()) {
    if (typeof key !== "string") continue;
    const at = rows.findIndex((row) => new RegExp(`(^|[\\s{,])${key}:`).test(row));
    if (at >= 0) return firstLine + at;
  }
  return firstLine;
}

function issueErrors(issues: readonly z.core.$ZodIssue[], rows: readonly string[], firstLine: number, prefix: string): SheetError[] {
  return issues.map((issue) => ({ line: lineOf(rows, firstLine, issue.path), message: `${[prefix, ...issue.path.map(String)].filter(Boolean).join(".")}: ${issue.message}` }));
}

const YamlMap = z.record(z.string(), z.unknown());

function frontScope(value: unknown): SheetScope {
  const map = YamlMap.safeParse(value).data;
  if (map === undefined) return {};
  const { initiative, lane, week } = map;
  return { ...(typeof initiative === "string" && { initiative }), ...((typeof lane === "string" || lane === null) && { lane }), ...(typeof week === "string" && { week }) };
}

function parseFront(rows: readonly string[], errors: SheetError[]): { front?: SheetFrontMatter; scope: SheetScope; next: number } {
  if (rows[0]?.trim() !== "---") {
    errors.push({ line: 1, message: "a sheet opens with a `---` front matter block" });
    return { scope: {}, next: 0 };
  }
  const end = rows.findIndex((row, at) => at > 0 && row.trim() === "---");
  if (end < 0) {
    errors.push({ line: rows.length, message: "the front matter block is never closed" });
    return { scope: {}, next: rows.length };
  }
  const body = rows.slice(1, end);
  const value = yamlValue(body.join("\n"), 2, errors);
  const parsed = FrontMatterSchema.safeParse(value ?? {});
  if (!parsed.success) errors.push(...issueErrors(parsed.error.issues, body, 2, "front matter"));
  return { ...(parsed.success && { front: parsed.data }), scope: frontScope(value), next: end + 1 };
}

function blockOf(rows: string[], line: number, errors: SheetError[]): Block | undefined {
  const value = yamlValue(rows.join("\n"), line + 1, errors);
  if (value === undefined) return undefined;
  const map = YamlMap.safeParse(value).data ?? {};
  const keys = Object.keys(map);
  if (keys.length !== 1 || (keys[0] !== "outcome" && keys[0] !== "bet")) {
    errors.push({ line, message: "a yaml block holds exactly one top-level key, `outcome` or `bet`" });
    return undefined;
  }
  return { key: keys[0], value: map[keys[0]], line, rows };
}

/** Every fenced block after the front matter; a fence that is not `yaml` or never closes is an error. */
function scanBlocks(rows: readonly string[], from: number, errors: SheetError[]): Block[] {
  const blocks: Block[] = [];
  for (let at = from; at < rows.length; at++) {
    const fence = FENCE.exec(rows[at]!);
    if (fence === null) continue;
    const close = rows.findIndex((row, end) => end > at && FENCE.test(row));
    if (close < 0) {
      errors.push({ line: at + 1, message: "a fenced block is never closed" });
      break;
    }
    if (fence[1] !== "yaml") errors.push({ line: at + 1, message: `only \`yaml\` blocks are allowed, got \`${fence[1] || "(none)"}\`` });
    else blocks.push(...[blockOf(rows.slice(at + 1, close), at + 1, errors)].filter((block) => block !== undefined));
    at = close;
  }
  return blocks;
}

function readOutcome(blocks: readonly Block[], front: SheetFrontMatter | undefined, errors: SheetError[]): BetSheet["outcome"] | undefined {
  const outcomes = blocks.filter((block) => block.key === "outcome");
  if (outcomes.length !== 1) {
    errors.push({ line: outcomes[1]?.line ?? 1, message: `a sheet holds exactly one outcome block, found ${outcomes.length}` });
    return undefined;
  }
  const block = outcomes[0]!;
  const parsed = OutcomeBlockSchema.safeParse(block.value);
  if (!parsed.success) return void errors.push(...issueErrors(parsed.error.issues, block.rows, block.line + 1, "outcome"));
  return { ...parsed.data, id: `${front?.initiative ?? ""}/${parsed.data.local}` };
}

function readBets(blocks: readonly Block[], front: SheetFrontMatter | undefined, outcome: string, errors: SheetError[]): SheetBet[] {
  const bets: SheetBet[] = [];
  for (const block of blocks.filter((candidate) => candidate.key === "bet")) {
    const parsed = BetBlockSchema.safeParse(block.value);
    if (!parsed.success) errors.push(...issueErrors(parsed.error.issues, block.rows, block.line + 1, "bet"));
    else bets.push({ ...parsed.data, id: `${front?.initiative ?? ""}/${parsed.data.local}`, outcome, line: block.line + 1, citesLine: lineOf(block.rows, block.line + 1, ["cites"]) });
  }
  return bets;
}

function checkUnique(bets: readonly SheetBet[], errors: SheetError[]): void {
  const seen = { order: new Set<number>(), local: new Set<string>() };
  for (const bet of bets) {
    if (seen.order.has(bet.order)) errors.push({ line: bet.line, message: `bet ${bet.local}: order ${bet.order} is used by an earlier bet` });
    if (seen.local.has(bet.local)) errors.push({ line: bet.line, message: `bet ${bet.local}: local is used by an earlier bet` });
    seen.order.add(bet.order);
    seen.local.add(bet.local);
  }
}

function digestIds(front: SheetFrontMatter, digestText: DigestText, errors: SheetError[]): ReadonlySet<string> | undefined {
  const text = digestText(front.digest);
  if (text === undefined) return void errors.push({ line: 1, message: `digest ${front.digest} not found` });
  const digest = parseIntentDigest(text);
  if (digest.ok) return new Set(digest.lines.map((line) => line.id));
  const first = digest.errors[0]!;
  errors.push({ line: 1, message: `digest ${front.digest} does not parse (${digest.errors.length} error(s); first at its line ${first.line}: ${first.message})` });
  return undefined;
}

/** Each bet stands on at least one line of its digest, and no cite into that digest names a line it lacks. */
function checkCites(sheet: Pick<BetSheet, "front" | "bets">, ids: ReadonlySet<string>, errors: SheetError[]): void {
  const own = (ref: string) => ref.startsWith(`${sheet.front.digest}/`);
  for (const bet of sheet.bets) {
    for (const cite of bet.cites.filter((entry) => own(entry.intent_ref) && !ids.has(entry.intent_ref))) {
      errors.push({ line: bet.citesLine, message: `bet ${bet.local} cites ${cite.intent_ref}, which is not in digest ${sheet.front.digest}` });
    }
    if (!bet.cites.some((entry) => ids.has(entry.intent_ref))) errors.push({ line: bet.citesLine, message: `bet ${bet.local} cites no line of digest ${sheet.front.digest}` });
  }
}

/** Parses one sheet and checks its cites against the digest it names; any error fails the whole sheet, never a partial read. */
export function parseBetSheet(text: string, digestText: DigestText): BetSheetResult {
  const errors: SheetError[] = [];
  const rows = text.split(/\r?\n/);
  const { front, scope, next } = parseFront(rows, errors);
  const blocks = scanBlocks(rows, next, errors);
  const outcome = readOutcome(blocks, front, errors);
  const bets = readBets(blocks, front, outcome?.id ?? "", errors);
  checkUnique(bets, errors);
  const ids = front && digestIds(front, digestText, errors);
  if (front && ids) checkCites({ front, bets }, ids, errors);
  if (errors.length > 0 || !front || !outcome) return { ok: false, errors: errors.sort((a, b) => a.line - b.line), scope };
  return { ok: true, sheet: { front, outcome, bets } };
}

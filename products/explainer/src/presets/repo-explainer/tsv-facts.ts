import { parseClaimsAudit, parseTopicsJudged, readTsv, type ClaimRow, type TopicRow } from "@titan-design/pm";
import { parseCites } from "./cite.js";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import type { ExplainerFact } from "./schemas.js";

const TOPICS_TSV = "synthesis/final/topics-judged.tsv";
const LEDGER_TSV = "ledger.tsv";
const CLAIMS_TSV = "synthesis/final/claims-audit.tsv";

interface FactParse {
  facts: ExplainerFact[];
  diagnostics: GatherDiagnostic[];
}

type LedgerRow = ReturnType<typeof readTsv>[number];
type Parse<Row> = (text: string, file: string) => Row[];
interface Located<Row> {
  row: Row;
  selector: string;
}

// Columns the facts read beyond the ones pm's parser already requires.
const TOPIC_COLUMNS = ["license_safe", "repo_evidence", "rows", "rows_verified_yes", "row_ids"] as const;
const LEDGER_COLUMNS = ["id", "kind", "claim", "evidence", "tier", "license-safe", "verified"] as const;
const CLAIM_COLUMNS = ["note"] as const;

// The review measures a topic as verified when four rows in five check out against the code.
const TOPIC_VERIFIED_SHARE = 0.8;
const COUNT = /^\d+$/;
const CLAIM_VERIFIED: Record<string, ExplainerFact["verified"]> = {
  verified: "yes",
  partial: "partial",
  "not-found": "docs",
  refuted: "no",
};

function parseLedger(text: string, file: string): LedgerRow[] {
  return readTsv(text, LEDGER_COLUMNS, file);
}

// pm throws naming the columns it requires; the explainer's own are appended so one E-COLUMNS
// names every column the facts need.
function parseColumns<Row>(text: string, file: string, required: readonly string[], parse: Parse<Row>): Row[] | string {
  const header = (text.split(/\r?\n/, 1)[0] ?? "").split("\t");
  const missing = required.filter((name) => !header.includes(name)).join(", ");
  let rows: Row[];
  try {
    rows = parse(text, file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return missing === "" ? message : `${message}, ${missing}`;
  }
  return missing === "" ? rows : `${file}: header lacks ${missing}`;
}

// pm pads a short row and drops a long row's spill. The reviews write TSVs with QUOTE_NONE, so a
// stray tab shifts cells: any row whose cell count differs from the header is skipped with
// W-BAD-ROW rather than read with misplaced columns.
function misshapenRows(text: string, file: string): { lines: Set<number>; diagnostics: GatherDiagnostic[] } {
  const [header = "", ...rows] = text.split(/\r?\n/);
  const width = header.split("\t").length;
  const lines = new Set<number>();
  const diagnostics: GatherDiagnostic[] = [];
  rows.forEach((raw, index) => {
    const cells = raw.split("\t").length;
    if (raw.trim() === "" || cells === width) return;
    const selector = `${file}:L${index + 2}`;
    lines.add(index + 2);
    diagnostics.push(diag("W-BAD-ROW", `${selector} has ${cells} cells, header has ${width}`, selector));
  });
  return { lines, diagnostics };
}

function parseRows<Row extends { line: number }>(
  text: string,
  file: string,
  { required, parse }: { required: readonly string[]; parse: Parse<Row> },
  toFact: (located: Located<Row>) => ExplainerFact | GatherDiagnostic | undefined,
): FactParse {
  const rows = parseColumns(text, file, required, parse);
  if (typeof rows === "string") return { facts: [], diagnostics: [diag("E-COLUMNS", rows, file)] };
  const { lines, diagnostics } = misshapenRows(text, file);
  const facts: ExplainerFact[] = [];
  for (const row of rows.filter(({ line }) => !lines.has(line))) {
    const out = toFact({ row, selector: `${file}:L${row.line}` });
    if (out === undefined) continue;
    if ("source" in out) facts.push(out);
    else diagnostics.push(out);
  }
  return { facts, diagnostics };
}

function topicFact({ row, selector }: Located<TopicRow>): ExplainerFact | GatherDiagnostic {
  const { license_safe, repo_evidence, rows: rowCount, rows_verified_yes, row_ids } = row.extra;
  if (!COUNT.test(rowCount!) || !COUNT.test(rows_verified_yes!)) {
    return diag("W-BAD-ROW", `${selector} has a non-numeric rows or rows_verified_yes count`, selector);
  }
  const rows = Number(rowCount);
  const rowsYes = Number(rows_verified_yes);
  return {
    id: row.topic_id,
    source: "topic",
    kind: "feature",
    text: `${row.title}: ${row.reason}`,
    evidence: parseCites(`${repo_evidence} ${row.reason}`),
    tier: row.tier,
    priority: row.priority,
    verdict: row.verdict,
    verified: rows > 0 && rowsYes / rows >= TOPIC_VERIFIED_SHARE ? "yes" : "partial",
    rows,
    rows_yes: rowsYes,
    license_safe: license_safe!.startsWith("yes"),
    row_ids: row_ids!.split(",").map((id) => id.trim()).filter((id) => id !== ""),
  };
}

// Gotchas are kept unless refuted, so a partly checked pitfall still reaches the script; guards
// are kept only when fully verified, since a guard is told as a promise the code keeps.
function ledgerKept(kind: string, verified: string): Pick<ExplainerFact, "kind" | "verified"> | undefined {
  const confirmed = verified === "yes" || verified === "citation-ok";
  if (kind === "guard") return confirmed ? { kind, verified: "yes" } : undefined;
  if (kind !== "gotcha") return undefined;
  if (confirmed) return { kind, verified: "yes" };
  return verified === "partial" ? { kind, verified: "partial" } : undefined;
}

function ledgerFact({ row: { fields: row } }: Located<LedgerRow>): ExplainerFact | undefined {
  const kept = ledgerKept(row.kind!, row.verified!);
  if (kept === undefined) return undefined;
  return {
    id: row.id!,
    source: "row",
    ...kept,
    text: row.claim!,
    evidence: parseCites(row.evidence!),
    tier: row.tier!,
    license_safe: row["license-safe"]!.startsWith("yes"),
  };
}

function claimFact({ row, selector }: Located<ClaimRow>): ExplainerFact | GatherDiagnostic {
  const verified = CLAIM_VERIFIED[row.status];
  if (verified === undefined) return diag("W-BAD-ROW", `${selector} has unknown claim status "${row.status}"`, selector);
  const note = row.note ?? "";
  return {
    id: row.id,
    source: "claim",
    kind: "claim",
    text: note === "" ? row.claim : `${row.claim} Audit: ${note}`,
    evidence: parseCites(row.evidence),
    tier: "docs",
    verified,
    // A docs claim quotes the project's own README, not licensed code; S9 still checks its spans.
    license_safe: true,
    claim_status: row.status,
  };
}

/** One `feature` fact per judged topic in `topics-judged.tsv`. */
export function topicFacts(text: string): FactParse {
  return parseRows(text, TOPICS_TSV, { required: TOPIC_COLUMNS, parse: parseTopicsJudged }, topicFact);
}

/** Gotcha rows that are not refuted and guard rows that verified, from `ledger.tsv`. */
export function ledgerFacts(text: string): FactParse {
  return parseRows(text, LEDGER_TSV, { required: [], parse: parseLedger }, ledgerFact);
}

/** One `claim` fact per audited docs claim in `claims-audit.tsv`. */
export function claimFacts(text: string): FactParse {
  return parseRows(text, CLAIMS_TSV, { required: CLAIM_COLUMNS, parse: parseClaimsAudit }, claimFact);
}

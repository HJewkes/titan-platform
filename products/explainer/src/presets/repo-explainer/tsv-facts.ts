import { parseCites } from "./cite.js";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import type { ExplainerFact } from "./schemas.js";

export const TOPICS_TSV = "synthesis/final/topics-judged.tsv";
export const LEDGER_TSV = "ledger.tsv";
export const CLAIMS_TSV = "synthesis/final/claims-audit.tsv";

export interface FactParse {
  facts: ExplainerFact[];
  diagnostics: GatherDiagnostic[];
}

type Row = Record<string, string>;
interface Located {
  row: Row;
  selector: string;
}

const TOPIC_COLUMNS = [
  "topic_id", "tier", "title", "verdict", "priority", "reason",
  "license_safe", "repo_evidence", "rows", "rows_verified_yes", "row_ids",
] as const;
const LEDGER_COLUMNS = ["id", "kind", "claim", "evidence", "tier", "license-safe", "verified"] as const;
const CLAIM_COLUMNS = ["id", "source", "status", "evidence", "note", "claim"] as const;

// The review measures a topic as verified when four rows in five check out against the code.
const TOPIC_VERIFIED_SHARE = 0.8;
const COUNT = /^\d+$/;
const CLAIM_VERIFIED: Record<string, ExplainerFact["verified"]> = {
  verified: "yes",
  partial: "partial",
  "not-found": "docs",
  refuted: "no",
};

// The reviews write TSVs with QUOTE_NONE, so a stray tab shifts cells: any row whose cell count
// differs from the header is skipped with W-BAD-ROW rather than read with misplaced columns.
function readTsv(text: string, file: string, required: readonly string[]): { rows: Located[]; diagnostics: GatherDiagnostic[] } {
  const [header = "", ...lines] = text.replace(/\r/g, "").split("\n");
  const columns = header.split("\t");
  const missing = required.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    return { rows: [], diagnostics: [diag("E-COLUMNS", `${file} lacks required column(s): ${missing.join(", ")}`, file)] };
  }
  const rows: Located[] = [];
  const diagnostics: GatherDiagnostic[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const selector = `${file}:L${index + 2}`;
    const cells = line.split("\t");
    if (cells.length !== columns.length) {
      diagnostics.push(diag("W-BAD-ROW", `${selector} has ${cells.length} cells, header has ${columns.length}`, selector));
      return;
    }
    rows.push({ row: Object.fromEntries(columns.map((name, i) => [name, cells[i]!])), selector });
  });
  return { rows, diagnostics };
}

function parseRows(
  text: string,
  file: string,
  required: readonly string[],
  toFact: (located: Located) => ExplainerFact | GatherDiagnostic | undefined,
): FactParse {
  const { rows, diagnostics } = readTsv(text, file, required);
  const facts: ExplainerFact[] = [];
  for (const located of rows) {
    const out = toFact(located);
    if (out === undefined) continue;
    if ("source" in out) facts.push(out);
    else diagnostics.push(out);
  }
  return { facts, diagnostics };
}

function topicFact({ row, selector }: Located): ExplainerFact | GatherDiagnostic {
  if (!COUNT.test(row.rows!) || !COUNT.test(row.rows_verified_yes!)) {
    return diag("W-BAD-ROW", `${selector} has a non-numeric rows or rows_verified_yes count`, selector);
  }
  const rows = Number(row.rows);
  const rowsYes = Number(row.rows_verified_yes);
  return {
    id: row.topic_id!,
    source: "topic",
    kind: "feature",
    text: `${row.title}: ${row.reason}`,
    evidence: parseCites(`${row.repo_evidence} ${row.reason}`),
    tier: row.tier!,
    priority: row.priority!,
    verdict: row.verdict!,
    verified: rows > 0 && rowsYes / rows >= TOPIC_VERIFIED_SHARE ? "yes" : "partial",
    rows,
    rows_yes: rowsYes,
    license_safe: row.license_safe!.startsWith("yes"),
    row_ids: row.row_ids!.split(",").map((id) => id.trim()).filter((id) => id !== ""),
  };
}

// Gotchas are kept unless refuted, so a partly checked pitfall still reaches the script; guards
// are kept only when fully verified, since a guard is told as a promise the code keeps.
function ledgerVerified(kind: string, verified: string): ExplainerFact["verified"] | undefined {
  const confirmed = verified === "yes" || verified === "citation-ok";
  if (kind === "guard") return confirmed ? "yes" : undefined;
  if (kind !== "gotcha") return undefined;
  if (confirmed) return "yes";
  return verified === "partial" ? "partial" : undefined;
}

function ledgerFact({ row }: Located): ExplainerFact | undefined {
  const verified = ledgerVerified(row.kind!, row.verified!);
  if (verified === undefined) return undefined;
  return {
    id: row.id!,
    source: "row",
    kind: row.kind as "gotcha" | "guard",
    text: row.claim!,
    evidence: parseCites(row.evidence!),
    tier: row.tier!,
    verified,
    license_safe: row["license-safe"]!.startsWith("yes"),
  };
}

function claimFact({ row, selector }: Located): ExplainerFact | GatherDiagnostic {
  const verified = CLAIM_VERIFIED[row.status!];
  if (verified === undefined) return diag("W-BAD-ROW", `${selector} has unknown claim status "${row.status}"`, selector);
  const note = row.note!.trim();
  return {
    id: row.id!,
    source: "claim",
    kind: "claim",
    text: note === "" ? row.claim! : `${row.claim} Audit: ${note}`,
    evidence: parseCites(row.evidence!),
    tier: "docs",
    verified,
    // A docs claim quotes the project's own README, not licensed code; S9 still checks its spans.
    license_safe: true,
    claim_status: row.status!,
  };
}

/** One `feature` fact per judged topic in `topics-judged.tsv`. */
export function topicFacts(text: string): FactParse {
  return parseRows(text, TOPICS_TSV, TOPIC_COLUMNS, topicFact);
}

/** Gotcha rows that are not refuted and guard rows that verified, from `ledger.tsv`. */
export function ledgerFacts(text: string): FactParse {
  return parseRows(text, LEDGER_TSV, LEDGER_COLUMNS, ledgerFact);
}

/** One `claim` fact per audited docs claim in `claims-audit.tsv`. */
export function claimFacts(text: string): FactParse {
  return parseRows(text, CLAIMS_TSV, CLAIM_COLUMNS, claimFact);
}

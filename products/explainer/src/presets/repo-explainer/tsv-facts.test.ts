import { describe, expect, it } from "vitest";
import { ExplainerFactSchema } from "./schemas.js";
import { claimFacts, ledgerFacts, topicFacts } from "./tsv-facts.js";

const tsv = (...lines: string[][]) => lines.map((cells) => cells.join("\t")).join("\n") + "\n";

const TOPIC_HEADER = [
  "topic_id", "tier", "title", "verdict", "priority", "titan_evidence", "reason", "license_safe",
  "corroboration", "repo_evidence", "rows", "rows_verified_yes", "rows_code", "kinds", "row_ids",
];
const topic = (id: string, rows: string, rowsYes: string) => [
  id, "workflow", "Pinned reviews", "missing", "P2", "CAPABILITIES.md:L71",
  "reviews pin to a commit (packages/review/src/source.ts:L40-L52)", "yes (MIT)", "code",
  "WB-241 diffr/src/lib.rs:L54-L77", rows, rowsYes, "7", "guard:4", "WB-222,WB-225",
];

const LEDGER_HEADER = [
  "id", "kind", "claim", "evidence", "tier", "license", "license-safe", "next-action", "source",
  "verified", "docs-only", "outside-view",
];
const ledger = (id: string, kind: string, verified: string) => [
  id, kind, `${kind} ${id} holds.`, "packages/local-vcs/src/file-lock.ts:L36-L65", "store", "MIT", "yes",
  "design-note", "WB-W1-004", verified, "no", "no",
];

const CLAIM_HEADER = ["id", "source", "status", "evidence", "basis", "note", "claim"];
const claim = (id: string, status: string, evidence = "") => [
  id, "README.md", status, evidence, "synth-checked", "", `Claim ${id}.`,
];

describe("topicFacts", () => {
  it("marks a topic verified at four rows in five and partial below it", () => {
    const { facts, diagnostics } = topicFacts(tsv(TOPIC_HEADER, topic("WBT-A", "10", "8"), topic("WBT-B", "10", "7")));

    expect(diagnostics).toEqual([]);
    expect(facts.map((fact) => [fact.id, fact.verified])).toEqual([
      ["WBT-A", "yes"],
      ["WBT-B", "partial"],
    ]);
  });

  it("carries the topic's tier, verdict, row ids and citations from evidence and reason", () => {
    const [fact] = topicFacts(tsv(TOPIC_HEADER, topic("WBT-A", "10", "8"))).facts;

    expect(ExplainerFactSchema.parse(fact)).toMatchObject({
      source: "topic",
      kind: "feature",
      tier: "workflow",
      priority: "P2",
      verdict: "missing",
      rows: 10,
      rows_yes: 8,
      license_safe: true,
      row_ids: ["WB-222", "WB-225"],
      evidence: [
        { path: "diffr/src/lib.rs", lineStart: 54, lineEnd: 77 },
        { path: "packages/review/src/source.ts", lineStart: 40, lineEnd: 52 },
      ],
    });
  });

  it("names a missing required column and returns no facts", () => {
    const header = TOPIC_HEADER.map((name) => (name === "rows_verified_yes" ? "rows_yes" : name));

    const { facts, diagnostics } = topicFacts(tsv(header, topic("WBT-A", "10", "8")));

    expect(facts).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: "E-COLUMNS", severity: "error" });
    expect(diagnostics[0]!.message).toContain("rows_verified_yes");
  });

  it("skips a row with a non-numeric count and keeps the rest", () => {
    const { facts, diagnostics } = topicFacts(tsv(TOPIC_HEADER, topic("WBT-A", "ten", "8"), topic("WBT-B", "4", "4")));

    expect(facts.map((fact) => fact.id)).toEqual(["WBT-B"]);
    expect(diagnostics).toMatchObject([{ code: "W-BAD-ROW", selector: "synthesis/final/topics-judged.tsv:L2" }]);
  });
});

describe("ledgerFacts", () => {
  it("keeps unrefuted gotchas and verified guards and drops every other row", () => {
    const text = tsv(
      LEDGER_HEADER,
      ledger("WB-1", "gotcha", "refuted"),
      ledger("WB-2", "gotcha", "partial"),
      ledger("WB-3", "guard", "citation-ok"),
      ledger("WB-4", "guard", "partial"),
      ledger("WB-5", "feature", "yes"),
      ledger("WB-6", "gotcha", "refuted-citation"),
    );

    const { facts, diagnostics } = ledgerFacts(text);

    expect(diagnostics).toEqual([]);
    expect(facts.map((fact) => [fact.id, fact.kind, fact.verified])).toEqual([
      ["WB-2", "gotcha", "partial"],
      ["WB-3", "guard", "yes"],
    ]);
    expect(facts.every((fact) => ExplainerFactSchema.safeParse(fact).success)).toBe(true);
    expect(facts[0]).toMatchObject({ source: "row", tier: "store", license_safe: true });
    expect(facts[0]!.evidence).toEqual([{ path: "packages/local-vcs/src/file-lock.ts", lineStart: 36, lineEnd: 65 }]);
  });

  it("warns on a short row and still parses the rows after it", () => {
    const short = ledger("WB-1", "gotcha", "yes").slice(0, 9);

    const { facts, diagnostics } = ledgerFacts(tsv(LEDGER_HEADER, short, ledger("WB-2", "gotcha", "yes")));

    expect(facts.map((fact) => fact.id)).toEqual(["WB-2"]);
    expect(diagnostics).toMatchObject([{ code: "W-BAD-ROW", severity: "warning", selector: "ledger.tsv:L2" }]);
  });

  it("warns on a row a stray tab has split into extra cells", () => {
    const long = [...ledger("WB-1", "gotcha", "yes"), "spill"];

    const { facts, diagnostics } = ledgerFacts(tsv(LEDGER_HEADER, long));

    expect(facts).toEqual([]);
    expect(diagnostics).toMatchObject([{ code: "W-BAD-ROW" }]);
  });
});

describe("claimFacts", () => {
  it("maps each audit status to its verified level", () => {
    const text = tsv(
      CLAIM_HEADER,
      claim("WB-C1", "verified", "packages/review/src/review-api/authoring-tools.ts:L15-L18"),
      claim("WB-C2", "partial"),
      claim("WB-C3", "not-found"),
      claim("WB-C4", "refuted"),
    );

    const { facts, diagnostics } = claimFacts(text);

    expect(diagnostics).toEqual([]);
    expect(facts.map((fact) => [fact.id, fact.verified, fact.claim_status])).toEqual([
      ["WB-C1", "yes", "verified"],
      ["WB-C2", "partial", "partial"],
      ["WB-C3", "docs", "not-found"],
      ["WB-C4", "no", "refuted"],
    ]);
    expect(ExplainerFactSchema.parse(facts[0])).toMatchObject({
      source: "claim",
      kind: "claim",
      text: "Claim WB-C1.",
      evidence: [{ path: "packages/review/src/review-api/authoring-tools.ts", lineStart: 15, lineEnd: 18 }],
    });
  });

  it("appends the audit note to the claim text", () => {
    const row = claim("WB-C1", "partial");
    row[5] = "only the CLI path checks out";

    expect(claimFacts(tsv(CLAIM_HEADER, row)).facts[0]!.text).toBe("Claim WB-C1. Audit: only the CLI path checks out");
  });

  it("warns on an unknown status instead of guessing a level", () => {
    const { facts, diagnostics } = claimFacts(tsv(CLAIM_HEADER, claim("WB-C1", "maybe"), claim("WB-C2", "verified")));

    expect(facts.map((fact) => fact.id)).toEqual(["WB-C2"]);
    expect(diagnostics).toMatchObject([{ code: "W-BAD-ROW", selector: "synthesis/final/claims-audit.tsv:L2" }]);
  });

  it("names every missing column at once", () => {
    const { diagnostics } = claimFacts(tsv(["id", "source", "evidence", "claim"], ["WB-C1", "README.md", "", "x"]));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain("status, note");
  });
});

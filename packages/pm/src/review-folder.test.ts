import { describe, expect, it } from "vitest";
import { parseClaimsAudit, parseTopicsJudged, readReviewPin, sumRunCost } from "./review-folder.js";

const tsv = (...lines: string[][]) => lines.map((cells) => cells.join("\t")).join("\n");

const COMMON = ["topic_id", "tier", "title", "verdict", "priority", "titan_evidence", "reason"];
const TOPIC = ["WID-CORE-01", "T1", "Widget cache", "missing", "P1", "none", "no cache today"];

describe("parseTopicsJudged", () => {
  it("parses the common header and keeps its trailing columns in extra", () => {
    const rows = parseTopicsJudged(
      tsv([...COMMON, "license_safe", "repo_evidence"], [...TOPIC, "yes", "src/cache.ts:10"]),
    );

    expect(rows).toEqual([
      {
        line: 2,
        topic_id: "WID-CORE-01",
        tier: "T1",
        title: "Widget cache",
        verdict: "missing",
        priority: "P1",
        titan_evidence: "none",
        reason: "no cache today",
        extra: { license_safe: "yes", repo_evidence: "src/cache.ts:10" },
      },
    ]);
  });

  it("parses a header that interleaves other columns and drops repo_evidence", () => {
    const header = ["topic_id", "tier", "title", "verdict", "priority", "titan_evidence", "w2_evidence", "reason", "wave"];
    const row = ["WID-CORE-02", "T2", "Lens list", "have-worse", "P2", "lens.ts", "w2 note", "thin", "2"];

    const [topic] = parseTopicsJudged(tsv(header, row));

    expect(topic).toMatchObject({ topic_id: "WID-CORE-02", reason: "thin", extra: { w2_evidence: "w2 note", wave: "2" } });
  });

  it("throws naming the file when the header lacks priority", () => {
    const header = COMMON.filter((column) => column !== "priority");

    expect(() => parseTopicsJudged(tsv(header), "acme-widget/topics-judged.tsv")).toThrow(
      "acme-widget/topics-judged.tsv: header lacks priority",
    );
  });
});

describe("parseClaimsAudit", () => {
  it("reads note when present and leaves absent optional columns out", () => {
    const rows = parseClaimsAudit(
      tsv(
        ["id", "source", "status", "evidence", "basis", "note", "claim"],
        ["C1", "README.md:4", "verified", "src/a.ts:1", "code", "checked", "Widgets render offline"],
      ),
    );

    expect(rows).toEqual([
      {
        line: 2,
        id: "C1",
        source: "README.md:4",
        status: "verified",
        evidence: "src/a.ts:1",
        claim: "Widgets render offline",
        basis: "code",
        note: "checked",
      },
    ]);
  });

  it("reads a wave column in place of note", () => {
    const [claim] = parseClaimsAudit(
      tsv(["id", "source", "status", "evidence", "basis", "wave", "claim"], ["C2", "docs", "refuted", "-", "docs", "2", "Fast"]),
    );

    expect(claim).toMatchObject({ wave: "2", status: "refuted" });
    expect(claim).not.toHaveProperty("note");
  });

  it("throws when the header lacks claim", () => {
    expect(() => parseClaimsAudit(tsv(["id", "source", "status", "evidence"]))).toThrow("claims-audit.tsv: header lacks claim");
  });
});

describe("readReviewPin", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("reads capitalised keys and trims HEAD to its hash", () => {
    const readme = [
      "# acme-widget review",
      "",
      "- Remote: https://example.com/acme/widget",
      `- HEAD: ${sha} (2026-01-01 "Release 1.0")`,
      "- Status: pinned; skim next.",
      "- Mode: default. PREFIX=WID.",
    ].join("\n");

    expect(readReviewPin(readme)).toEqual({
      remote: "https://example.com/acme/widget",
      head: sha,
      status: "pinned; skim next.",
      mode: "default. PREFIX=WID.",
    });
  });

  it("reads lower-case keys and a short HEAD", () => {
    const readme = [
      "- remote: https://example.com/acme/widget (1k stars at review time)",
      "- HEAD: 0123abc (2026-01-02, \"Merge\")",
      "- pinned: 2026-01-02 by a reviewer",
      "- focus: offline rendering",
    ].join("\n");

    expect(readReviewPin(readme)).toEqual({
      remote: "https://example.com/acme/widget",
      head: "0123abc",
      pinned: "2026-01-02 by a reviewer",
      focus: "offline rendering",
    });
  });

  it("keeps the first bullet for a key and ignores keys it does not know", () => {
    const readme = ["- status: complete", "- clone: elsewhere", "", "## Log", "- status: pinned"].join("\n");

    expect(readReviewPin(readme)).toEqual({ status: "complete" });
  });
});

describe("sumRunCost", () => {
  const header = ["id", "total_cost_usd", "is_error", "ts"];

  it("sums cost, calls and errors, ignoring the header and blank lines", () => {
    const runs = [
      tsv(header, ["r1", "1.5", "false", "2026-01-01T00:00:00.000Z"]),
      "",
      tsv(["r2", "2.25", "true", "2026-01-03T00:00:00.000Z"]),
      "   ",
      tsv(["r3", "", "false", "2026-01-02T00:00:00.000Z"]),
      "",
    ].join("\n");

    expect(sumRunCost(runs)).toEqual({ usd: 3.75, calls: 3, errors: 1, lastTs: "2026-01-03T00:00:00.000Z" });
  });

  it("answers zero and no timestamp for a header-only file", () => {
    expect(sumRunCost(tsv(header))).toEqual({ usd: 0, calls: 0, errors: 0, lastTs: null });
  });

  it("throws naming the line of a cost that is not a number", () => {
    expect(() => sumRunCost(tsv(header, ["r1", "lots", "false", ""]))).toThrow("runs.tsv:2: total_cost_usd is not a number");
  });
});

import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { checkCandidatesMigration, checkCandidatesTable, type CandidateInput, type CheckCandidates } from "./check-candidates-store.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function table(times: string[] = ["2026-11-01T00:00:00.000Z"]): CheckCandidates {
  const db = openDatabase(":memory:");
  runMigrations(db, [checkCandidatesMigration(1)]);
  let tick = 0;
  return checkCandidatesTable(db, () => times[Math.min(tick++, times.length - 1)] ?? "");
}

function candidate(extra: Partial<CandidateInput> = {}): CandidateInput {
  return {
    runId: "run-7",
    repo: "Acme/Widgets",
    pr: 7,
    head: HEAD_A,
    classKey: "unchecked-input",
    route: "lint",
    sketch: "flag a parse without a schema",
    area: "packages/demo",
    member: { shape: "correctness", agentId: "reviewer-1", verdict: "FIX_FIRST" },
    locator: "packages/demo/src/a.ts:10",
    ...extra,
  };
}

describe("checkCandidatesTable", () => {
  it("two members, one class, one head is one row with both members", () => {
    const candidates = table();

    candidates.record([candidate(), candidate({ member: { shape: "adversary", agentId: "reviewer-2", verdict: "MERGE" }, locator: "packages/demo/src/b.ts:4" })]);

    const rows = candidates.since("2026-01-01T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo: "acme/widgets",
      verdict: "FIX_FIRST",
      members: [{ shape: "correctness", agentId: "reviewer-1", verdict: "FIX_FIRST" }, { shape: "adversary", agentId: "reviewer-2", verdict: "MERGE" }],
      locators: ["packages/demo/src/a.ts:10", "packages/demo/src/b.ts:4"],
      confirmed: null,
    });
  });

  it("one class at two heads is two rows", () => {
    const candidates = table();

    candidates.record([candidate(), candidate({ head: HEAD_B })]);

    expect(candidates.since("2026-01-01T00:00:00.000Z").map((row) => row.head)).toEqual([HEAD_A, HEAD_B]);
  });

  it("confirm marks only the named heads", () => {
    const candidates = table();
    candidates.record([candidate(), candidate({ head: HEAD_B }), candidate({ pr: 8 })]);

    const marked = candidates.confirm("acme/widgets", 7, [HEAD_A]);

    expect(marked).toBe(1);
    const confirmed = candidates.since("2026-01-01T00:00:00.000Z").map((row) => [row.pr, row.head, row.confirmed]);
    expect(confirmed).toEqual([[7, HEAD_A, true], [7, HEAD_B, null], [8, HEAD_A, null]]);
  });

  it("a re-recorded member is not listed twice", () => {
    const candidates = table();

    candidates.record([candidate()]);
    candidates.record([candidate()]);

    const [row] = candidates.since("2026-01-01T00:00:00.000Z");
    expect(row?.members).toEqual([{ shape: "correctness", agentId: "reviewer-1", verdict: "FIX_FIRST" }]);
    expect(row?.locators).toEqual(["packages/demo/src/a.ts:10"]);
  });

  it("since leaves out rows recorded before the date", () => {
    const candidates = table(["2026-11-01T00:00:00.000Z", "2026-11-09T00:00:00.000Z"]);

    candidates.record([candidate()]);
    candidates.record([candidate({ classKey: "missing-await" })]);

    expect(candidates.since("2026-11-08T00:00:00.000Z").map((row) => row.classKey)).toEqual(["missing-await"]);
  });
});

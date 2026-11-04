import { describe, expect, it } from "vitest";
import { DROP_REASONS, parseReport } from "./report-contract.js";

describe("return-contract report parser", () => {
  it("reads the status, PR and plan path from a worker or planner report", () => {
    const report = parseReport("\n**Status: DONE_WITH_CONCERNS**\nPR: https://github.com/o/r/pull/9\nPlan: /aw/cc/sources/CC-1-plan.md\n");

    expect(report).toEqual(
      expect.objectContaining({ status: "DONE_WITH_CONCERNS", pr: "https://github.com/o/r/pull/9", plan: "/aw/cc/sources/CC-1-plan.md" }),
    );
  });

  it("reads a reviewer verdict from the first line", () => {
    expect(parseReport("Verdict: APPROVE\nLooks right.").verdict).toBe("APPROVE");
  });

  it("reads a closing PARKED line as the question id, and none when PARKED is not last", () => {
    expect(parseReport("Status: NEEDS_CONTEXT\nAsked which schema to keep.\nPARKED 3f9a").parked).toBe("3f9a");
    expect(parseReport("Status: DONE\nPARKED 3f9a\nPR: https://github.com/o/r/pull/9").parked).toBeUndefined();
  });

  it("yields unknown for a last message it cannot read, never DONE", () => {
    const report = parseReport("I think everything is finished now.");

    expect(report.status).toBe("unknown");
    expect(report.verdict).toBeUndefined();
    expect(report.firstLine).toBe("I think everything is finished now.");
  });

  it.each([
    ["Status: DONE. Plan: /aw/x/sources/p.md", "DONE"],
    ["Status: done, read-only", "DONE"],
    ["Status: DONE_WITH_CONCERNS (two caveats)", "DONE_WITH_CONCERNS"],
    ["Status: PARTIAL. Round 1 imported", "unknown"],
    ["Status: process card done", "unknown"],
  ])("reads the status word from %j as %s", (firstLine, status) => {
    expect(parseReport(`${firstLine}\nPR: none`).status).toBe(status);
  });

  it("reads the Head sha and the CI paste up to the Concerns line", () => {
    const report = parseReport(
      ["Status: DONE", "PR: o/r#9", "Head: 0123456789abcdef0123456789abcdef01234567", "CI:", "validate\tpass\t2m\thttps://ci/1", "Concerns: none"].join("\n"),
    );

    expect(report.head).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(report.ci).toEqual({ state: "pass", text: "validate\tpass\t2m\thttps://ci/1" });
  });

  it.each([
    ["one failing row among passes", "CI:\nlint\tpass\t1m\nunit\tfail\t3m", "fail"],
    ["a pending row among passes", "CI: build pass, unit pending", "pending"],
    ["no PR to check", "CI: n/a", "none"],
    ["prose it cannot read", "CI: see above", "unknown"],
  ])("reads CI with %s as %s", (_, ci, state) => {
    expect(parseReport(`Status: DONE\n${ci}`).ci?.state).toBe(state);
  });

  it("leaves Head unset when the line holds no sha", () => {
    expect(parseReport("Status: BLOCKED\nHead: none").head).toBeUndefined();
  });
});

describe("report proposed tasks need a destination (decision 331)", () => {
  const reportWith = (...items: string[]): string => ["Status: DONE", "PR: https://github.com/o/r/pull/9", "Proposed tasks:", ...items].join("\n");

  it("reads filed, pending and dropped items from a Proposed tasks block", () => {
    const report = parseReport(
      reportWith("- Add a lint rule -> filed TP-9001", "* **Split the parser** -> pending: waits on F4", "- Rename x -> dropped: duplicate", "", "Notes: done"),
    );

    expect(report.proposed).toEqual([
      { text: "Add a lint rule", destination: { kind: "filed", id: "TP-9001" } },
      { text: "Split the parser", destination: { kind: "pending", reason: "waits on F4" } },
      { text: "Rename x", destination: { kind: "dropped", reason: "duplicate" } },
    ]);
    expect(report.refused).toBeUndefined();
    expect(report.status).toBe("DONE");
  });

  it("refuses a report with an item that has no destination, naming the item", () => {
    const report = parseReport(reportWith("- Add a lint rule -> filed TP-9001", "- Retry the flaky test"));

    expect(report.refused).toEqual(expect.stringContaining('"Retry the flaky test" has no destination'));
    expect(report.status).toBe("DONE");
  });

  it("refuses an arrow to something that is not filed, pending or dropped", () => {
    expect(parseReport(reportWith("- Retry the flaky test -> later")).refused).toEqual(expect.stringContaining("has no destination"));
  });

  it.each([
    ["a drop reason off the allow list", "- Rename x -> dropped: not worth it", 'dropped for "not worth it"'],
    ["an empty pending reason", "- Rename x -> pending:", "pending with no reason"],
  ])("refuses %s", (_, item, reason) => {
    expect(parseReport(reportWith(item)).refused).toEqual(expect.stringContaining(reason));
  });

  it.each(DROP_REASONS)("accepts the allow-listed drop reason %s", (reason) => {
    expect(parseReport(reportWith(`- Rename x -> dropped: ${reason}`)).refused).toBeUndefined();
  });

  it("a report with no Proposed tasks block is not refused", () => {
    const report = parseReport("Status: DONE\nPR: https://github.com/o/r/pull/9");

    expect(report.proposed).toBeUndefined();
    expect(report.refused).toBeUndefined();
  });
});

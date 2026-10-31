import { describe, expect, it } from "vitest";
import { briefOf, leaksAnswer, parseCorpusV3, selectCandidates, type CandidateFacts, type CorpusV3Row, type SelectOptions, type TestChange } from "./select.js";

const MERGE = "abcdef1234567890abcdef1234567890abcdef12";

function row(caseId: string, overrides: Partial<CorpusV3Row> = {}): CorpusV3Row {
  return {
    case_id: caseId,
    repo: "titan-platform",
    pr_number: 100,
    base_commit: "1".repeat(40),
    merge_commit: MERGE,
    class: "local-fix",
    n_tasks: 1,
    task_ids: ["TP-1"],
    task: { id: "TP-1", initiative: "titan-platform" },
    title: "Fix the thing",
    brief_text: "Fix the thing. Done when the cache is bounded.",
    follow_up_fixes: [],
    ...overrides,
  };
}

/** Facts keyed by case id, so each row can be pointed at one fact-driven skip. */
function factsFor(overrides: Record<string, { lock?: boolean; parents?: number; change?: TestChange }> = {}): CandidateFacts {
  const of = (r: CorpusV3Row) => overrides[r.case_id] ?? {};
  return {
    hasSupportedLock: async (r) => of(r).lock ?? true,
    mergeParents: async (r) => of(r).parents ?? 1,
    testChange: async (r) => of(r).change ?? "tests-and-source",
  };
}

const OPTIONS: SelectOptions = { repos: ["titan-platform", "active-work"], classes: ["mechanical", "local-fix", "feature-slice"], seed: "s1" };

describe("parseCorpusV3", () => {
  it("reads rows, ignores extra fields and blank lines", () => {
    const text = `${JSON.stringify({ ...row("titan-platform#1"), D: 4, class_facts: {} })}\n\n`;
    expect(parseCorpusV3(text)).toEqual([row("titan-platform#1")]);
  });

  it("refuses a malformed line by its number", () => {
    const text = [JSON.stringify(row("a#1")), "{not json", JSON.stringify(row("a#3"))].join("\n");
    expect(() => parseCorpusV3(text)).toThrow(/^corpus line 2:/);
  });

  it("refuses a row missing its merge commit by its number", () => {
    const partial = { ...row("a#1"), merge_commit: undefined };
    expect(() => parseCorpusV3(`${JSON.stringify(row("a#1"))}\n${JSON.stringify(partial)}`)).toThrow(/^corpus line 2:/);
  });
});

describe("selectCandidates", () => {
  it("skips each disqualified row with its own reason and keeps the clean one", async () => {
    const rows = [
      row("clean#1"),
      row("voltras-mcp#2", { repo: "voltras-mcp" }),
      row("no-lock#3"),
      row("release#4", { class: "release" }),
      row("two-tasks#5", { n_tasks: 2 }),
      row("merge-commit#6"),
      row("tests#7"),
      row("source#8"),
      row("leak#9", { brief_text: "Bound the cache (#100)" }),
    ];
    const facts = factsFor({ "no-lock#3": { lock: false }, "merge-commit#6": { parents: 2 }, "tests#7": { change: "test-only" }, "source#8": { change: "no-test-change" } });

    const selection = await selectCandidates(rows, OPTIONS, facts);

    expect(selection.byClass).toEqual({ mechanical: [], "local-fix": [row("clean#1")], "feature-slice": [] });
    expect(selection.skipped).toEqual([
      { caseId: "voltras-mcp#2", reason: "private-repo" },
      { caseId: "no-lock#3", reason: "unsupported-runner" },
      { caseId: "release#4", reason: "class-not-requested" },
      { caseId: "two-tasks#5", reason: "tangled" },
      { caseId: "merge-commit#6", reason: "tangled" },
      { caseId: "tests#7", reason: "test-only" },
      { caseId: "source#8", reason: "no-test-change" },
      { caseId: "leak#9", reason: "brief-leak" },
    ]);
  });

  it("asks the clone nothing about a row the row alone disqualifies", async () => {
    const asked: string[] = [];
    const facts: CandidateFacts = {
      hasSupportedLock: async (r) => (asked.push(r.case_id), true),
      mergeParents: async () => 1,
      testChange: async () => "tests-and-source",
    };

    await selectCandidates([row("private#1", { repo: "owner/voltras-mcp" }), row("kept#2")], OPTIONS, facts);

    expect(asked).toEqual(["kept#2"]);
  });

  it("orders each class by the seed: stable for one seed, reshuffled by another", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`titan-platform#${i + 1}`, { pr_number: i + 1, class: i % 2 ? "mechanical" : "local-fix" }));
    const ids = async (seed: string) => {
      const { byClass } = await selectCandidates(rows, { ...OPTIONS, seed }, factsFor());
      return Object.fromEntries(Object.entries(byClass).map(([cls, pool]) => [cls, pool.map((r) => r.case_id)]));
    };

    const first = await ids("s1");

    expect(await ids("s1")).toEqual(first);
    expect(await ids("s2")).not.toEqual(first);
    expect(first["local-fix"]).not.toEqual(rows.filter((r) => r.class === "local-fix").map((r) => r.case_id));
    expect([...(first.mechanical ?? [])].sort()).toEqual(rows.filter((r) => r.class === "mechanical").map((r) => r.case_id).sort());
  });
});

describe("leaksAnswer", () => {
  const target = { pr_number: 123, merge_commit: MERGE };

  it.each([
    ["its own PR number", "Bound the cache (#123)"],
    ["the merge sha prefix", "Reverts ABCDEF1 behaviour"],
    ["where it landed", "Landed in the daemon module"],
  ])("flags a brief naming %s", (_, brief) => {
    expect(leaksAnswer(brief, target)).toBe(true);
  });

  it.each([
    ["another PR", "Follows up #1234 and #12"],
    ["a plain brief", "Bound the cache; done when evictions are counted"],
  ])("passes a brief naming %s", (_, brief) => {
    expect(leaksAnswer(brief, target)).toBe(false);
  });
});

describe("briefOf", () => {
  it("uses the task brief when the row has one and the PR title otherwise", () => {
    expect(briefOf(row("a#1", { brief_text: "Bound the cache" }))).toBe("Bound the cache");
    expect(briefOf(row("b#2", { brief_text: null, title: "Fix the thing" }))).toBe("Fix the thing");
  });
});

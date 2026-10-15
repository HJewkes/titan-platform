import { describe, expect, it } from "vitest";
import { ExplainerFactSchema } from "./schemas.js";
import {
  capabilityFacts,
  codeSpanEvidence,
  entryPointFacts,
  integrationRecFacts,
  ownerQuestionFacts,
  readCoverage,
  readFirstFacts,
  readPin,
  shouldNotFacts,
  splitSections,
  summaryFacts,
  whatItIsFacts,
} from "./summary-facts.js";

const SHA = "2ddf3eb6c13d97b1d04a932c21de9a92029adaf9";

const SUMMARY = `# whiteboard (devdotfast/whiteboard): review summary

## Pin

- \`coverage.sh\` (LC_ALL=C): \`repo=whiteboard head=2ddf3eb6 tracked=7602 unread=0 read-records=3071\`.

## What it is, in titan tiers

whiteboard is a **hitl / dashboard-kit** product for one direction of the human loop. The server validates every
block against the pinned commits (\`store.ts:L1446-L1576\`). Too short to keep.

## Integration recommendations (would-be tasks; none filed, per the owner)

**Adopt now** (small, MIT, lands in code that is being built this week)
- **A1. Anchors on OwnerItem and round@2 parts** (from WBT-WF-04). Take the grammar from
  \`packages/review/src/review-api/authoring-tools.ts:L43-L47\`.
- **A2. Anchored selections on OwnerAnswer** (from WBT-HITL-08).

**Adapt** (needs a titan-shaped design first)
- **B1. Lens list per PR head** (WBT-HITL-13).

**Idea** (P3; read the topic before acting)
- diffr as an external binary for structural hunks in gate briefs (WBT-CG-09).

## Capability-to-tier table

| tier | whiteboard implementation | verdict | evidence |
|---|---|---|---|
| hitl | anchors, selections, lenses; no answer path | missing (P1/P2) | \`agent-selection.ts:L7-L44\` |
| session-graph / session-read | hook capture, commit trailer | missing / have-worse (P2) | \`trace-git-hook-runner.ts:L42-L105\` |

## What we should not do

- **Do not vendor the VS Code fork or the canvas.** The console's titan-design UI is the surface.
- **Do not copy the live-drawing UX** (draw queue, couriers, WBT-DKB-05).

## Five files to read first

1. \`packages/review/instructions/authoring.md\` (36 lines): the whole agent workflow and the one fan-out.
2. \`packages/review/src/review-api/component-reference.ts\` (30 lines) with \`blocks/index.ts:L44-L60\`: the blocks.
3. \`packages/review/src/agent-selection.ts\` and \`packages/review/src/review-api/http.ts:L1062-L1185\`: selection.
4. \`packages/review/src/review-api/store.ts:L1366-L1576\`: presence, version race and anchor validation on edit.
5. \`packages/trace-core/src/trace-git-hook-runner.ts\` and \`trace-read.ts:L561-L840\`: trailer and blame.

## Owner's four questions

**(a) Main use cases: is it just PRs?** No, but it is only about code and nothing else at all. A review targets a
worktree, a commit range, or a GitHub PR (\`document.ts:L123-L138\`).

| pattern | where | usefulness |
|---|---|---|
| Source anchors pinned and checked on every write | \`store.ts:L1446\` | High |

**(b) Capabilities.** Pinned, validated reviews of typed blocks in twelve kinds.
`;

const parsed = (facts: unknown[]) => facts.map((fact) => ExplainerFactSchema.parse(fact));
const kindsOf = (facts: { kind: string }[]) => new Set(facts.map((fact) => fact.kind));

describe("summaryFacts", () => {
  it("emits schema-valid facts of every tour kind from a full SUMMARY", () => {
    const { facts, missing } = summaryFacts(SUMMARY);

    expect(missing).toEqual([]);
    expect(parsed(facts)).toHaveLength(facts.length);
    expect(kindsOf(facts)).toEqual(
      new Set(["what-it-is", "integration-rec", "capability", "should-not", "read-first", "fact"]),
    );
  });

  it("reports an absent section and emits none of its facts", () => {
    const summary = SUMMARY.replace("## Five files to read first", "## Five favourite files");

    const { facts, missing } = summaryFacts(summary);

    expect(missing).toEqual(["read-first"]);
    expect(facts.filter((fact) => fact.kind === "read-first")).toEqual([]);
  });

  it("matches a section by heading prefix so a drifted tail still parses", () => {
    const summary = SUMMARY.replace("## What it is, in titan tiers", "## What it is");

    expect(summaryFacts(summary).facts.some((fact) => fact.kind === "what-it-is")).toBe(true);
  });

  it("marks a fact unsafe when any cited path fails the license check", () => {
    const { facts } = summaryFacts(SUMMARY, { isLicenseSafe: (path) => !path.startsWith("trace") });

    expect(facts.find((fact) => fact.id === "X-READ-5")?.license_safe).toBe(false);
    expect(facts.find((fact) => fact.id === "X-READ-1")?.license_safe).toBe(true);
  });
});

describe("splitSections", () => {
  it("ends a section at the next ## heading", () => {
    const sections = splitSections("## One\nalpha\n## Two\nbeta\n### Sub\ngamma\n");

    expect(sections.get("One")).toBe("alpha");
    expect(sections.get("Two")).toBe("beta\n### Sub\ngamma\n");
  });
});

describe("whatItIsFacts", () => {
  it("keeps sentences of 40 characters or more, numbered, with their citations", () => {
    const body = splitSections(SUMMARY).get("What it is, in titan tiers")!;

    const facts = whatItIsFacts(body);

    expect(facts.map((fact) => fact.id)).toEqual(["X-WHAT-01", "X-WHAT-02"]);
    expect(facts[1]!.evidence).toEqual([{ path: "store.ts", lineStart: 1446, lineEnd: 1576 }]);
    expect(facts.every((fact) => fact.verified === "yes" && fact.source === "summary")).toBe(true);
  });
});

describe("integrationRecFacts", () => {
  const body = splitSections(SUMMARY).get("Integration recommendations (would-be tasks; none filed, per the owner)")!;

  it("ids labelled bullets by label and groups them under the preceding bold line", () => {
    const facts = integrationRecFacts(body);

    expect(facts.map((fact) => [fact.id, fact.group])).toEqual([
      ["X-REC-A1", "Adopt now"],
      ["X-REC-A2", "Adopt now"],
      ["X-REC-B1", "Adapt"],
      ["X-REC-idea-01", "Idea"],
    ]);
  });

  it("folds continuation lines into the bullet and cites from them", () => {
    const [first] = integrationRecFacts(body);

    expect(first!.text).toContain("Take the grammar from `packages/review/src/review-api/authoring-tools.ts:L43-L47`.");
    expect(first!.evidence).toEqual([
      { path: "packages/review/src/review-api/authoring-tools.ts", lineStart: 43, lineEnd: 47 },
    ]);
  });
});

describe("capabilityFacts", () => {
  it("emits one fact per table row carrying the tier and verdict columns", () => {
    const facts = capabilityFacts(splitSections(SUMMARY).get("Capability-to-tier table")!);

    expect(facts.map((fact) => [fact.id, fact.tier, fact.verdict])).toEqual([
      ["X-CAP-hitl", "hitl", "missing (P1/P2)"],
      ["X-CAP-session-graph-session-read", "session-graph / session-read", "missing / have-worse (P2)"],
    ]);
    expect(facts[0]!.evidence).toEqual([{ path: "agent-selection.ts", lineStart: 7, lineEnd: 44 }]);
  });

  it("emits nothing from a table without a tier column", () => {
    expect(capabilityFacts("| a | b |\n|---|---|\n| x | y |")).toEqual([]);
  });
});

describe("shouldNotFacts", () => {
  it("numbers each bullet", () => {
    const facts = shouldNotFacts(splitSections(SUMMARY).get("What we should not do")!);

    expect(facts.map((fact) => fact.id)).toEqual(["X-NOT-01", "X-NOT-02"]);
    expect(facts[0]!.kind).toBe("should-not");
  });
});

describe("readFirstFacts", () => {
  const facts = readFirstFacts(splitSections(SUMMARY).get("Five files to read first")!);

  it("numbers the five items X-READ-1 to X-READ-5", () => {
    expect(facts.map((fact) => fact.id)).toEqual(["X-READ-1", "X-READ-2", "X-READ-3", "X-READ-4", "X-READ-5"]);
  });

  it("cites a named file at file level with no invented lines", () => {
    expect(facts[0]!.evidence).toEqual([{ path: "packages/review/instructions/authoring.md" }]);
  });

  it("keeps both a cited range and a file named alongside it", () => {
    expect(facts[2]!.evidence).toEqual([
      { path: "packages/review/src/review-api/http.ts", lineStart: 1062, lineEnd: 1185 },
      { path: "packages/review/src/agent-selection.ts" },
    ]);
  });

  it("binds backticked bare ranges to the path before them, as archify writes them", () => {
    const [fact] = readFirstFacts("2. `archify/bin/finalize.mjs` `L326-L366` and `L471-L609`: the gate.");

    expect(fact!.evidence).toEqual([
      { path: "archify/bin/finalize.mjs", lineStart: 326, lineEnd: 366 },
      { path: "archify/bin/finalize.mjs", lineStart: 471, lineEnd: 609 },
    ]);
  });
});

describe("ownerQuestionFacts", () => {
  it("splits each lettered answer into sentences grouped by its question, skipping tables", () => {
    const facts = ownerQuestionFacts(splitSections(SUMMARY).get("Owner's four questions")!);

    expect(facts.map((fact) => [fact.id, fact.group])).toEqual([
      ["X-OQ-a-01", "Main use cases: is it just PRs?"],
      ["X-OQ-a-02", "Main use cases: is it just PRs?"],
      ["X-OQ-b-01", "Capabilities."],
    ]);
    expect(facts[1]!.evidence).toEqual([{ path: "document.ts", lineStart: 123, lineEnd: 138 }]);
  });
});

describe("codeSpanEvidence", () => {
  it("does not bind a bare range across an intervening non-path span", () => {
    expect(codeSpanEvidence("`a/b.ts` then `npm test` then `L5`")).toEqual([{ path: "a/b.ts" }]);
  });

  it("reads a member chain as code, not a file", () => {
    expect(codeSpanEvidence("the `rounds.submit` page and `file-lenses.md`")).toEqual([{ path: "file-lenses.md" }]);
  });
});

describe("entryPointFacts", () => {
  const bullets = "- CLI: `whiteboard` (`packages/review/src/cli.ts`).\n- MCP server (`packages/review/src/review-api/mcp.ts`),\n  JSON tool API.\n";

  it("parses bullets under a ### Entry points heading up to the next heading", () => {
    const readme = `## Shape\n\nText.\n\n### Entry points\n\n${bullets}\n### Vendoring split\n\n- not an entry\n`;

    const facts = parsed(entryPointFacts(readme));

    expect(facts.map((fact) => fact.id)).toEqual(["X-ENTRY-01", "X-ENTRY-02"]);
    expect(facts[1]!.text).toBe("MCP server (`packages/review/src/review-api/mcp.ts`), JSON tool API.");
    expect(facts.every((fact) => fact.source === "readme" && fact.verified === "docs")).toBe(true);
    expect(facts[0]!.evidence).toEqual([{ path: "packages/review/src/cli.ts" }]);
  });

  it("parses bullets under an archify-style **Entry points** line up to the next paragraph", () => {
    const readme = `Shape text.\n\n**Entry points**\n${bullets}\n**Counts**: 798 tracked.\n- a later list\n`;

    expect(entryPointFacts(readme)).toHaveLength(2);
  });

  it("returns nothing when the README has no entry-points block", () => {
    expect(entryPointFacts("# Repo\n\n- HEAD: abc\n")).toEqual([]);
  });
});

describe("readPin", () => {
  it("reads the 40-hex after HEAD: with trailing commit text", () => {
    expect(readPin(`# r\n\n- Remote: x\n- HEAD: ${SHA} (2026-10-11 "Hide diff chrome (#1087)")\n`)).toBe(SHA);
  });

  it("returns nothing for a short or overlong sha", () => {
    expect(readPin("- HEAD: 2ddf3eb6 (2026-10-11)")).toBeUndefined();
    expect(readPin(`- HEAD: ${SHA}0`)).toBeUndefined();
  });
});

describe("readCoverage", () => {
  it("finds unread=0 in a whiteboard bullet", () => {
    expect(readCoverage(SUMMARY)).toEqual({
      unread: 0,
      line: "- `coverage.sh` (LC_ALL=C): `repo=whiteboard head=2ddf3eb6 tracked=7602 unread=0 read-records=3071`.",
    });
  });

  it("finds unread=0 in an archify table row", () => {
    const row = "| coverage | `repo=archify head=58ab0b9 tracked=798 unread=0 read-records=981` (`coverage.sh` exits 0) |";

    expect(readCoverage(`## Pin\n\n| | |\n|---|---|\n${row}\n`)?.unread).toBe(0);
  });

  it("reads unread=3 as 3 and unread=03 as 3, never as 0", () => {
    expect(readCoverage("- coverage: unread=3 read=10")?.unread).toBe(3);
    expect(readCoverage("- coverage: unread=03")?.unread).toBe(3);
  });

  it("returns nothing without a coverage line", () => {
    expect(readCoverage("- status: unread=0\n- coverage pending")).toBeUndefined();
  });
});

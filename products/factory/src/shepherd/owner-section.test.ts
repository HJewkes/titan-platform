import { readFileSync } from "node:fs";
import { lintPrSection } from "@titan-design/decider";
import { QuestionSchema, SectionSchema } from "@titan-design/review-schema";
import { describe, expect, it } from "vitest";
import { buildOwnerSection, type OwnerSectionInput } from "./owner-section.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const AC311: OwnerSectionInput = JSON.parse(fixture("owner-section-ac311.json"));
const HEAD = AC311.pr.head;

/** ac#311 once its head was reviewed: MERGE at the PR head, gate at the PR head. */
function reviewedAtHead(over: Partial<OwnerSectionInput> = {}): OwnerSectionInput {
  return { ...AC311, gate: { ...AC311.gate, head: HEAD }, verdict: { ...AC311.verdict!, head: HEAD }, ...over };
}

describe("buildOwnerSection on the agent-chat#311 fixture", () => {
  it("renders the plan's section and passes lintPrSection", () => {
    const { markdown } = buildOwnerSection(AC311);

    expect(markdown).toBe(fixture("owner-section-ac311.md"));
    expect(lintPrSection(markdown)).toEqual([]);
  });

  it("emits a round@2 section and a pick-one question recommending a re-review", () => {
    const { section, question } = buildOwnerSection(AC311);

    expect(SectionSchema.parse(section).context).toContain("#### Why it reaches you");
    expect(QuestionSchema.parse(question)).toMatchObject({ kind: "pick-one", recommendation: { answer: "Defer", by: "tc-cc-436-review" } });
  });
});

describe("buildOwnerSection on the reviewed head", () => {
  it("states a reviewed head behind the PR head as a con", () => {
    const stale = buildOwnerSection(AC311).markdown;
    const current = buildOwnerSection(reviewedAtHead()).markdown;

    expect(stale).toContain("- The commits after 2bbd21a have had no review");
    expect(current).not.toContain("have had no review");
  });

  it("says a PR with no verdict is not reviewed, never that it was reviewed at the gate head", () => {
    const { markdown, question } = buildOwnerSection({ ...AC311, verdict: undefined });

    expect(markdown).not.toContain("reviewed at");
    expect(markdown).toContain("head 38d98b6 (not reviewed)");
    expect(markdown).toContain("No reviewer has given a verdict on this PR.");
    expect(markdown).toContain("- No reviewer has read 38d98b6");
    expect(question.recommendation?.answer).toBe("Changes needed");
  });

  it("names the gate head and the review head apart when they differ", () => {
    const { markdown } = buildOwnerSection({ ...AC311, verdict: { ...AC311.verdict!, head: "5e5e5e5" } });

    expect(markdown).toContain("(reviewed at 5e5e5e5)");
    expect(markdown).toContain("The gate is at 2bbd21a, but the PR head is 38d98b6.");
    expect(markdown).toContain("The last review is at 5e5e5e5;");
    expect(markdown).not.toContain("The gate is at 5e5e5e5");
  });

  it("does not recommend merge when MERGE is at the PR head but the gate sits at an older head", () => {
    const { markdown, question } = buildOwnerSection({ ...AC311, verdict: { ...AC311.verdict!, head: HEAD } });

    expect(markdown).not.toContain("**Recommendation: merge.**");
    expect(markdown).toContain("The gate is at 2bbd21a, but the PR head is 38d98b6.");
    expect(markdown).toContain("- The gate was opened at 2bbd21a, not at the PR head 38d98b6");
    expect(question.recommendation?.answer).toBe("Defer");
  });

  it("recommends merge when MERGE is at the PR head and CI is green", () => {
    const { markdown, question } = buildOwnerSection(reviewedAtHead());

    expect(markdown).toContain("**Recommendation: merge.**");
    expect(question.recommendation?.answer).toBe("Approve merge");
  });

  it("recommends changes when the last verdict is FIX_FIRST", () => {
    const { question } = buildOwnerSection(reviewedAtHead({ verdict: { ...AC311.verdict!, head: HEAD, verdict: "FIX_FIRST" } }));

    expect(question.recommendation?.answer).toBe("Changes needed");
  });
});

describe("buildOwnerSection without a reviewer owner brief", () => {
  it("leaves pros empty so lintPrSection refuses the section", () => {
    const { markdown } = buildOwnerSection(reviewedAtHead({ verdict: { ...AC311.verdict!, head: HEAD, ownerBrief: null } }));

    expect(markdown).toContain("Door type: not stated");
    expect(lintPrSection(markdown).map((f) => f.rule)).toContain("PR4");
  });
});

describe("buildOwnerSection for a UI PR", () => {
  const ui = (visuals: OwnerSectionInput["visuals"]): OwnerSectionInput => reviewedAtHead({ pr: { ...AC311.pr, ui: true }, visuals });

  it("pairs before and after images per story and offers them as variants", () => {
    const pair = { story: "navitem--live", width: "390", before: "img/pr-311/before/navitem.png", after: "img/pr-311/after/navitem.png" };
    const { markdown, section } = buildOwnerSection(ui({ base: "aaaaaaa1", pairs: [pair] }));

    expect(markdown).toContain("| navitem--live / 390 | ![](img/pr-311/before/navitem.png) | ![](img/pr-311/after/navitem.png) |");
    expect(section.variantKeys).toEqual([pair.before, pair.after]);
    expect(lintPrSection(markdown)).toEqual([]);
  });

  it("states why there are no visuals instead of dropping the part", () => {
    const { markdown } = buildOwnerSection(ui(undefined));

    expect(markdown).toContain("No visuals: no before and after capture was found for 38d98b6.");
    expect(lintPrSection(markdown)).toEqual([]);
  });
});

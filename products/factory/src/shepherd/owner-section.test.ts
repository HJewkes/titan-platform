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

    expect(stale).toContain("- The commits after 2bbd21a have had no Shepherd review");
    expect(current).not.toContain("have had no Shepherd review");
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

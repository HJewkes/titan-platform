import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintAsk, lintMorningList, lintOwnerQuestions, type AskFinding, type AskItemFindings } from "./ask-lint.js";

/** Verbatim items from the 2026-10-04 Morning list, and vc-65 rewritten under the contract. */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ask-lint");

const rulesOf = (findings: readonly AskFinding[]) => findings.map((f) => f.rule);
const evidenceOf = (findings: readonly AskFinding[], rule: string) => findings.find((f) => f.rule === rule)?.evidence ?? "";
const NOW = " Now: none.";

async function fixtureItems(name: string): Promise<Map<string, AskItemFindings>> {
  const items = lintMorningList(await readFile(path.join(DIR, name), "utf8"));
  return new Map(items.map((item) => [item.id, item]));
}

describe("the 2026-10-04 Morning items before the contract", () => {
  it("flags vc-65 as a batch of bare ids pointing at a plan with no current value", async () => {
    const vc65 = (await fixtureItems("2026-10-04-before.md")).get("vc-65");

    expect(rulesOf(vc65?.findings ?? [])).toEqual(["AQ1", "AQ2", "AQ3", "AQ4"]);
    expect(evidenceOf(vc65?.findings ?? [], "AQ1")).toContain('"defaults" within 4 words');
    expect(evidenceOf(vc65?.findings ?? [], "AQ1")).toContain('"6 Qs"');
    for (const id of ["VW-343", "VW-792", "VW-793"]) expect(evidenceOf(vc65?.findings ?? [], "AQ2")).toContain(`bare id ${id} `);
    expect(evidenceOf(vc65?.findings ?? [], "AQ4")).toContain("VW-343-plan.md");
  });

  it("flags vc-55 as a batch answer on defaults", async () => {
    const vc55 = (await fixtureItems("2026-10-04-before.md")).get("vc-55");

    expect(rulesOf(vc55?.findings ?? [])).toEqual(["AQ1", "AQ2", "AQ3"]);
    expect(evidenceOf(vc55?.findings ?? [], "AQ1")).toBe('"defaults" within 4 words of "recommend"');
  });

  it("flags tc-D as a batch over a decision id range", async () => {
    const tcD = (await fixtureItems("2026-10-04-before.md")).get("tc-D");

    expect(rulesOf(tcD?.findings ?? [])).toEqual(["AQ1", "AQ2", "AQ3", "AQ4"]);
    expect(evidenceOf(tcD?.findings ?? [], "AQ1")).toBe('id range "D1 to D11"');
  });
});

describe("vc-65 rewritten under the contract", () => {
  it("passes every rule for each of its five sub-items", async () => {
    const items = await fixtureItems("vc-65-after.md");

    expect([...items.keys()]).toEqual(["vc-65.1", "vc-65.2", "vc-65.3", "vc-65.4", "vc-65.5"]);
    for (const item of items.values()) expect(item.findings).toEqual([]);
  });
});

describe("AQ1 one decision per question", () => {
  it.each([
    ["an id range", "Recommend yes on Q3-Q6.", 'id range "Q3-Q6"'],
    ["a hash range", "Recommend merging ac#361 to #368 in one window.", 'id range "ac#361 to #368"'],
    ["a count of questions", "Recommend yes to all 4 questions in the plan.", 'question count "4 questions"'],
    ["three distinct Q ids", "Recommend yes for Q1, Q2 and Q7.", "3 distinct Q/D ids (Q1, Q2, Q7)"],
  ])("fires on %s and names it", (_, question, evidence) => {
    expect(evidenceOf(lintAsk({ question: question + NOW }), "AQ1")).toContain(evidence);
  });

  it("fires on an accept-all option", () => {
    const findings = lintAsk({ question: "Recommend the plan as written." + NOW, options: [{ label: "Accept all", description: "take every default the plan lists" }] });

    expect(evidenceOf(findings, "AQ1")).toBe('option "Accept all"');
  });

  it("lets a principle cover two listed items but not one", () => {
    const two = "Principle: recommend yes. The planner settles file layout itself. It covers (a) the new figure and (b) the sheet order." + NOW;
    const one = "Principle: recommend yes. The planner settles file layout itself. It covers (a) the new figure." + NOW;

    expect(lintAsk({ question: two })).toEqual([]);
    expect(evidenceOf(lintAsk({ question: one }), "AQ1")).toBe("Principle: lists 1 covered items, needs 2 or more");
  });
});

describe("AQ2 bare references", () => {
  it("passes an id described in place and exempts a repeated id", () => {
    const described = "Recommend yes. VW-12 adds a strength tint to the body figure." + NOW;
    const repeated = "Recommend yes. Ship VW-12 and VW-12 now." + NOW;

    expect(lintAsk({ question: described })).toEqual([]);
    expect(rulesOf(lintAsk({ question: repeated }))).not.toContain("AQ2");
  });

  it("reads a sub-item id whole, so VW-65.1 and VW-651 are two ids", () => {
    const evidence = evidenceOf(lintAsk({ question: "Recommend merging VW-65.1 then VW-651." }), "AQ2");

    expect(evidence).toContain("bare id VW-65.1 ");
    expect(evidence).toContain("bare id VW-651 ");
    expect(evidence).not.toContain("bare id VW-65 ");
  });

  it("does not treat a sub-item and its look-alike as a repeat", () => {
    const evidence = evidenceOf(lintAsk({ question: "Recommend VW-65.1 over VW-651." }), "AQ2");

    expect(evidence).toMatch(/VW-65\.1 .*VW-651 /);
  });

  it("ignores an id inside a command span", () => {
    expect(lintAsk({ question: "Recommend run: close the finished task. `! aw done TP-12`" })).toEqual([]);
  });

  it("fires on a short option label with a short description, sparing Yes and No", () => {
    const findings = lintAsk({
      question: "Recommend keeping the cap at three retries." + NOW,
      options: [
        { label: "Keep", description: "as is" },
        { label: "No", description: "" },
      ],
    });

    expect(evidenceOf(findings, "AQ2")).toBe('option "Keep" has a description under 4 words');
  });
});

describe("AQ3 to AQ5", () => {
  it("fires AQ3 without a Now: marker and spares a command item", () => {
    expect(evidenceOf(lintAsk({ question: "Recommend keeping the cap at three retries." }), "AQ3")).toBe("no Now: marker");
    expect(lintAsk({ question: "Recommend run: restart the widget service." })).toEqual([]);
  });

  it("fires AQ4 on a URL with little around it and names the pointer", () => {
    const findings = lintAsk({ question: "Recommend yes, see https://example.com/plan." + NOW });

    expect(evidenceOf(findings, "AQ4")).toMatch(/^points at "https:\/\/example\.com\/plan\." with \d+ content words$/);
  });

  it("fires AQ4 on a PR body pointer", () => {
    expect(evidenceOf(lintAsk({ question: "Recommend yes, as the PR body says." + NOW }), "AQ4")).toContain('"PR body"');
  });

  it("fires AQ5 only when no recommendation is given anywhere it may be", () => {
    const question = "Which hue should the tint use? Blue reads as information." + NOW;

    expect(evidenceOf(lintAsk({ question }), "AQ5")).toBe("no recommendation in the first sentence");
    expect(lintAsk({ question, recommended: "Blue" })).toEqual([]);
    expect(lintAsk({ question, options: [{ label: "Blue (Recommended)", description: "the status-info token in both themes" }] })).toEqual([]);
  });
});

describe("plan owner questions", () => {
  const plan = [
    "# Plan",
    "",
    "## 4. Owner questions",
    "",
    "1. Recommend deepen only. Leftover budget goes to depth because breadth already has quotas.",
    "   Now: none.",
    "2. Which schema form? Recommendation: zod peer, matching the agent package.",
    "",
    "## 5. Risks",
    "",
    "1. Recommend nothing here; this is not a question.",
  ].join("\n");

  it("lints each entry of the section with its continuation lines", () => {
    const items = lintOwnerQuestions(plan);

    expect(items.map((item) => [item.id, rulesOf(item.findings)])).toEqual([
      ["1", []],
      ["2", ["AQ3", "AQ5"]],
    ]);
  });

  it("numbers unnumbered bullets by position", () => {
    const items = lintOwnerQuestions("### Owner questions\n- Recommend yes. Now: none.\n- Recommend no. Now: none.\n");

    expect(items.map((item) => item.id)).toEqual(["1", "2"]);
  });
});

describe("linear time and two false positives (TP-1684)", () => {
  // Best of three, so a CI runner stalling once under parallel load does not read as superlinear time.
  const elapsedMs = (run: () => void) => {
    const samples = [0, 1, 2].map(() => {
      const start = performance.now();
      run();
      return performance.now() - start;
    });
    return Math.min(...samples);
  };
  // Best of three: a loaded CI runner can stall any single run past the bound (#577).
  const lintTime = (question: string) =>
    Math.min(...[1, 2, 3].map(() => elapsedMs(() => lintAsk({ question }))));
  const baseline = () => Math.max(lintTime("Recommend yes." + NOW), lintTime("Recommend yes." + NOW));

  it("lints a 50 kB token with no spaces in bounded time", () => {
    const bound = 4 * baseline() + 50;

    for (const filler of ["a", "a.", "a#", "a/"]) {
      expect(lintTime("Recommend yes. " + filler.repeat(50_000 / filler.length) + NOW)).toBeLessThan(Math.max(bound, 100));
    }
  });

  it("lints distinct ids in linear time, not quadratic", () => {
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const timeFor = (count: number) => {
      const ids = Array.from({ length: count }, (_, i) => `VW-${i}`).join(" ");
      const question = "Recommend yes. " + ids + NOW;
      lintAsk({ question });
      return median(Array.from({ length: 5 }, () => {
        const start = performance.now();
        lintAsk({ question });
        return performance.now() - start;
      }));
    };

    const ratio = timeFor(14_000) / Math.max(timeFor(7000), 1);

    // Linear growth doubles the time; quadratic quadruples it. A load spike shifts both sizes alike.
    expect(ratio).toBeLessThan(3);
  });

  it("does not read Node.js or a slash-separated list as a path", () => {
    const question = "Recommend yes: run the build on Node.js and align the label left/right/center in the card header." + NOW;

    expect(rulesOf(lintAsk({ question }))).not.toContain("AQ4");
  });

  it("still reads a real file path as a pointer", () => {
    expect(rulesOf(lintAsk({ question: "Recommend yes, see docs/plan.md." + NOW }))).toContain("AQ4");
  });

  it("does not count item(s) as a Principle enumerator", () => {
    const findings = lintAsk({ question: "Principle: keep item(s) small and one(s) clear." + NOW });

    expect(evidenceOf(findings, "AQ1")).toBe("Principle: lists 0 covered items, needs 2 or more");
  });
});

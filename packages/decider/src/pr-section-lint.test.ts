import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintPrSection, type PrSectionFinding } from "./pr-section-lint.js";

/** The agent-chat#311 section before (round 1) and after (Morning 81, corrected), plus a UI pair. */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "pr-section");

const fixture = (name: string) => readFile(path.join(DIR, name), "utf8");
const rulesOf = (findings: readonly PrSectionFinding[]) => findings.map((f) => f.rule);
const evidenceOf = (findings: readonly PrSectionFinding[], rule: string) => findings.find((f) => f.rule === rule)?.evidence ?? "";

describe("the agent-chat#311 owner section", () => {
  it("passes the hand-written Morning 81 section with its facts corrected", async () => {
    expect(lintPrSection(await fixture("ac311-morning-81.md"))).toEqual([]);
  });

  it("fails the round-1 metadata dump on description, why-asked and pros and cons", async () => {
    const findings = lintPrSection(await fixture("ac311-round-1.md"));

    expect(rulesOf(findings)).toEqual(["PR1", "PR2", "PR3", "PR4"]);
    expect(evidenceOf(findings, "PR2")).toBe("no What it does section");
    expect(evidenceOf(findings, "PR3")).toBe("no Why it reaches you section");
    expect(evidenceOf(findings, "PR4")).toBe("no Pros section; no Cons section");
  });
});

describe("a UI pull request section", () => {
  it("passes with a before and after image pair for every changed story", async () => {
    expect(lintPrSection(await fixture("ui-with-images.md"))).toEqual([]);
  });

  it("passes with no images when it states why there are none", async () => {
    expect(lintPrSection(await fixture("ui-with-reason.md"))).toEqual([]);
  });

  it("flags a story whose after image is missing", async () => {
    const section = (await fixture("ui-with-images.md")).replace("![](img/pr-42/after/card--dense-1280.png)", "");

    const findings = lintPrSection(section);

    expect(rulesOf(findings)).toEqual(["PR5"]);
    expect(evidenceOf(findings, "PR5")).toBe("story card--dense / 1280 lacks a before and after image pair");
  });

  it("flags an empty Before and after section", async () => {
    const section = (await fixture("ui-with-reason.md")).replace(/No images:.*\n/, "\n");

    expect(evidenceOf(lintPrSection(section), "PR5")).toBe("Before and after has 0 image(s) and no stated reason");
  });

  it("flags a UI section that drops the Before and after section", async () => {
    const section = (await fixture("ui-with-images.md")).split("#### Before and after")[0] ?? "";

    expect(evidenceOf(lintPrSection(section), "PR5")).toBe("UI PR with no Before and after section");
  });
});

describe("a section that has every part but breaks one rule", () => {
  const base = (body: { what?: string; why?: string; pros?: string; cons?: string }) =>
    [
      "https://github.com/example/tool/pull/7",
      "## What it does",
      body.what ?? "The CLI printed raw ids. It now prints names.",
      "## Why it reaches you",
      body.why ?? "Accidental: authority rule `MRG-AU` read a transient merge state.",
      "## Pros",
      body.pros ?? "- Readable output.",
      "## Cons",
      body.cons ?? "- Scripts parsing ids break.",
    ].join("\n");

  it("passes the base section", () => {
    expect(lintPrSection(base({}))).toEqual([]);
  });

  it("counts one sentence plus bullets as too short a description", () => {
    const findings = lintPrSection(base({ what: "It prints names instead of ids.\n- One. Two. Three." }));

    expect(evidenceOf(findings, "PR2")).toBe("What it does has 1 sentence(s), needs 2");
  });

  it("does not count dots inside code spans or URLs as sentence ends", () => {
    const findings = lintPrSection(base({ what: "It reads `a. b. c. d.` from https://x.example/a. b. c. now." }));

    expect(rulesOf(findings)).toEqual(["PR2"]);
  });

  it("requires a rule id in backticks, not a task id", () => {
    const findings = lintPrSection(base({ why: "Accidental: a transient merge state, fixed by `TP-1688`." }));

    expect(evidenceOf(findings, "PR3")).toBe("names no rule id in backticks");
  });

  it("requires a gate class beside the rule id", () => {
    const findings = lintPrSection(base({ why: "Rule `shepherd-merge-guard/github-path` stopped it." }));

    expect(evidenceOf(findings, "PR3")).toContain("names no gate class");
  });

  it("flags an empty Cons section", () => {
    expect(evidenceOf(lintPrSection(base({ cons: "" })), "PR4")).toBe("Cons section is empty");
  });

  it("does not ask a non-UI section for images", () => {
    expect(rulesOf(lintPrSection(base({})))).not.toContain("PR5");
  });
});

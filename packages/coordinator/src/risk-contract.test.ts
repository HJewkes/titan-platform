import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvalState, readRiskContract, resolveProgramme, ruleDigest } from "./risk-contract.js";
import type { RiskContract } from "./risk-contract.js";

const RULE = "Each slice only adds refusals to the example guard; every previously allowed pinned row stays allowed.";

function contractWith(overrides: Partial<RiskContract> = {}): RiskContract {
  return {
    id: "RC-EXAMPLE-1",
    kind: "security",
    rule: RULE,
    delta: "strictly-stricter",
    paths: ["packages/example-guard/src/**"],
    requires: ["parse-budget", "guard-fuzz"],
    release: "shepherd",
    ownerApproval: { decision: "900(2)", ruleSha256: ruleDigest(RULE) },
    ...overrides,
  };
}

const planWith = (block: unknown): string =>
  ["# Plan", "", "Some prose.", "", "```risk-contract", JSON.stringify(block, null, 2), "```", ""].join("\n");

const DECISIONS = [
  "# Decisions",
  "",
  "## 899 (synthetic, earlier)",
  "1. Unrelated item.",
  "",
  "## 900 (synthetic owner sitting)",
  "1. First answer.",
  "2. Risk contracts: YES.",
  "",
  "## 901 (synthetic, later)",
  "3. A later item.",
  "",
  "77. Synthetic owner line. (1) one answer. (2) another answer.",
].join("\n");

describe("readRiskContract", () => {
  it("returns the contract from a well-formed block", () => {
    const contract = contractWith();

    const read = readRiskContract(planWith(contract));

    expect(read).toEqual({ contract });
  });

  it("returns a programme reference that does not restate the contract", () => {
    const read = readRiskContract(planWith({ id: "RC-EXAMPLE-1", programme: "contracts/RC-EXAMPLE-1.md" }));

    expect(read).toEqual({ contract: { id: "RC-EXAMPLE-1", programme: "contracts/RC-EXAMPLE-1.md" } });
  });

  it("reports a plan with no block", () => {
    expect(readRiskContract("# Plan\n\nNo contract here.\n")).toEqual({ problems: ["plan has no risk-contract block"] });
  });

  it("reports a block that is not JSON", () => {
    const read = readRiskContract("```risk-contract\n{ \"id\": \"RC-EXAMPLE-1\", // comment\n}\n```\n");

    expect(read.problems?.[0]).toMatch(/^risk-contract block is not JSON: /);
  });

  it("reports each wrong field by path", () => {
    const read = readRiskContract(planWith({ ...contractWith(), kind: "vibes", requires: ["prayer"] }));

    expect(read.problems).toEqual([
      expect.stringMatching(/^risk-contract block at kind: /),
      expect.stringMatching(/^risk-contract block at requires\.0: /),
    ]);
  });

  it("refuses a field the plan does not define", () => {
    const read = readRiskContract(planWith({ ...contractWith(), pinned: ["x"] }));

    expect(read.problems).toEqual([expect.stringMatching(/pinned/)]);
  });

  it("refuses two blocks in one plan", () => {
    const read = readRiskContract(planWith(contractWith()) + planWith(contractWith({ id: "RC-EXAMPLE-2" })));

    expect(read).toEqual({ problems: ["plan has 2 risk-contract blocks; one is allowed"] });
  });
});

describe("ruleDigest", () => {
  it("is the sha256 of the collapsed rule", () => {
    const expected = createHash("sha256").update("a b c").digest("hex");

    expect(ruleDigest("  a \n\tb   c ")).toBe(expected);
  });

  it("is stable under reflowed whitespace", () => {
    const reflowed = RULE.replace(/ /g, "\n  ").replace("Each", "\tEach");

    expect(ruleDigest(reflowed)).toBe(ruleDigest(RULE));
  });

  it("is stable under NFC and NFD spellings of the same text", () => {
    const composed = "Refuse café writes.";
    const decomposed = "Refuse café writes.";

    expect(ruleDigest(decomposed)).toBe(ruleDigest(composed));
  });

  it("changes when one word changes", () => {
    expect(ruleDigest(RULE.replace("refusals", "permissions"))).not.toBe(ruleDigest(RULE));
  });
});

describe("approvalState", () => {
  it("is approved when the decision part is recorded under its heading and the rule is unchanged", () => {
    expect(approvalState(contractWith(), DECISIONS)).toBe("approved");
  });

  it("stays approved after a whitespace-only edit of the rule", () => {
    const contract = contractWith({ rule: RULE.replace(/ /g, "\n   ") });

    expect(approvalState(contract, DECISIONS)).toBe("approved");
  });

  it("is unmet when one word of the rule changed after approval", () => {
    const contract = contractWith({ rule: RULE.replace("adds refusals", "adds permissions") });

    expect(approvalState(contract, DECISIONS)).toBe("unmet:rule changed since approval");
  });

  it("is unmet with no owner approval", () => {
    expect(approvalState(contractWith({ ownerApproval: undefined }), DECISIONS)).toBe("unmet:no owner approval");
  });

  it("is unmet when the decision id is absent from the decisions text", () => {
    const contract = contractWith({ ownerApproval: { decision: "902", ruleSha256: ruleDigest(RULE) } });

    expect(approvalState(contract, DECISIONS)).toBe("unmet:decision 902 not recorded");
  });

  it("is unmet when the part number sits under a different heading", () => {
    const contract = contractWith({ ownerApproval: { decision: "899(2)", ruleSha256: ruleDigest(RULE) } });

    expect(approvalState(contract, DECISIONS)).toBe("unmet:decision 899(2) not recorded");
  });

  it("does not count a decision id that is only mentioned in prose", () => {
    const contract = contractWith({ ownerApproval: { decision: "900", ruleSha256: ruleDigest(RULE) } });

    expect(approvalState(contract, "Background: decision 900 was discussed.\n")).toBe("unmet:decision 900 not recorded");
  });

  it.each([
    ["a whole heading", "900"],
    ["a numbered item", "77"],
    ["a part inside a numbered item", "77(2)"],
  ])("is approved for %s", (_, decision) => {
    const contract = contractWith({ ownerApproval: { decision, ruleSha256: ruleDigest(RULE) } });

    expect(approvalState(contract, DECISIONS)).toBe("approved");
  });

  it("is approved for a heading that spells the part out", () => {
    const decisions = "## 900(2): risk contracts approved\n";

    expect(approvalState(contractWith(), decisions)).toBe("approved");
  });
});

describe("resolveProgramme", () => {
  const PROGRAMME_PATH = "contracts/RC-EXAMPLE-1.md";
  const programmeText = planWith({ ...contractWith(), programme: PROGRAMME_PATH });
  const readFrom = (files: Record<string, string>) => (path: string) => files[path];

  it("returns a contract with no programme as it is", () => {
    const contract = contractWith();

    expect(resolveProgramme(contract, readFrom({}))).toEqual({ contract });
  });

  it("resolves a reference through the injected reader", () => {
    const resolved = resolveProgramme({ id: "RC-EXAMPLE-1", programme: PROGRAMME_PATH }, readFrom({ [PROGRAMME_PATH]: programmeText }));

    expect(resolved.contract?.rule).toBe(RULE);
    expect(resolved.contract && approvalState(resolved.contract, DECISIONS)).toBe("approved");
  });

  it("reports a missing programme file instead of an empty contract", () => {
    const resolved = resolveProgramme({ id: "RC-EXAMPLE-1", programme: PROGRAMME_PATH }, readFrom({}));

    expect(resolved).toEqual({ problems: [`programme ${PROGRAMME_PATH} not found`] });
  });

  it("reports a programme file with a malformed block", () => {
    const resolved = resolveProgramme(
      { id: "RC-EXAMPLE-1", programme: PROGRAMME_PATH },
      readFrom({ [PROGRAMME_PATH]: "```risk-contract\nnot json\n```\n" }),
    );

    expect(resolved.problems?.[0]).toMatch(new RegExp(`^programme ${PROGRAMME_PATH}: risk-contract block is not JSON`));
  });

  it("refuses a programme that cites another programme", () => {
    const chained = planWith({ id: "RC-EXAMPLE-1", programme: "contracts/other.md" });

    const resolved = resolveProgramme({ id: "RC-EXAMPLE-1", programme: PROGRAMME_PATH }, readFrom({ [PROGRAMME_PATH]: chained }));

    expect(resolved).toEqual({ problems: [`programme ${PROGRAMME_PATH} cites another programme`] });
  });

  it("refuses a plan block that restates a weaker rule than its programme", () => {
    const block = { ...contractWith({ rule: "Anything goes." }), programme: PROGRAMME_PATH };

    const resolved = resolveProgramme(block, readFrom({ [PROGRAMME_PATH]: programmeText }));

    expect(resolved).toEqual({ problems: [`plan block differs from programme ${PROGRAMME_PATH} at rule`] });
  });

  it("refuses a reference whose id differs from the programme's", () => {
    const resolved = resolveProgramme({ id: "RC-EXAMPLE-9", programme: PROGRAMME_PATH }, readFrom({ [PROGRAMME_PATH]: programmeText }));

    expect(resolved).toEqual({ problems: [`plan block differs from programme ${PROGRAMME_PATH} at id`] });
  });
});

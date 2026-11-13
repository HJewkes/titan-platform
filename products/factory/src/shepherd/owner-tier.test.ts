import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { decisionClassOf } from "../decision-class.js";
import { fakeLocator } from "../test-support/fakes.js";
import { decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type DecidableEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { OwnerTierMode } from "./owner-tier.js";
import type { PolicyTable } from "./g10-class-rules.js";
import { ownerTierPolicyRows, ownerTierRows, riskFactsOf, riskTier } from "./risk-tier.js";

const HEAD = fakeSha("owner-tier-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const PLAIN = "products/factory/src/shepherd/plain-module.ts";

/** One synthetic changed path per owner-tier row, each in the table the row names. */
const OWNER_TIER_FIXTURES = [
  ["merge-policy", "products/factory/src/shepherd/g10-release.ts"],
  ["hold-command", "products/factory/src/shepherd/release.ts"],
  ["owner-action", ".github/fix-proof.json"],
  ["gate-resolve-actor", "packages/workflow/src/runtime.ts"],
  ["gate-resolve-check", "products/factory/src/shepherd/gate-resolve-sites.test.ts"],
  ["CI workflow file", ".github/workflows/ci.yml"],
  ["publish file", "products/factory/src/shepherd/version-packages.ts"],
  ["settings file", "products/factory/src/config.ts"],
] as const;

const rowsOf = (paths: string[], ciBudget = false) => ownerTierRows({ paths, ciBudget });

const input: MergeEvidenceInput = {
  ...{ runId: "run-1", repo: "octo/demo", pr: 1, head: HEAD, seatGrants: ["merge-on-green-approve"] },
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
};

/** A reviewed MERGE at HEAD with green checks and a clean test merge, read under the given owner-tier mode. */
async function evidenceFor(paths: string[], ownerTier: OwnerTierMode | undefined) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("owner-tier-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, paths.map((path) => ({ path, status: "modified" as const })));
  return mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "feature" }, undefined, { ownerTier });
}

describe("ownerTierRows", () => {
  it.each(OWNER_TIER_FIXTURES)("a %s file is an owner-tier row", (row, path) => {
    expect(rowsOf([path, PLAIN])).toContain(`${row} ${path}`);
  });

  it("a policy path no table names is an owner-tier row", () => {
    const tablesOf = new Map<string, PolicyTable[]>([["products/factory/src/shepherd/new-rule.ts", []], [PLAIN, ["hold-closure"]]]);
    expect(ownerTierPolicyRows(tablesOf)).toEqual(["unnamed policy path products/factory/src/shepherd/new-rule.ts"]);
  });

  it("a policy path in a table off the stop list is not an owner-tier row", () => {
    expect(rowsOf(["products/factory/src/shepherd/hold-table-coverage.test.ts", "products/factory/src/shepherd/signoffs.ts"])).toEqual([]);
  });

  it("a case-folded spelling of a merge-policy file is still an owner-tier row", () => {
    expect(rowsOf(["Products/Factory/src/shepherd/G10-Release.ts"])).toContain("merge-policy products/factory/src/shepherd/g10-release.ts");
  });

  it("a visual path alone is not an owner-tier row", () => {
    expect(rowsOf(["packages/ui/src/button.tsx", "site/guides/shepherd.md"])).toEqual([]);
  });

  it("a test file beside a merge-policy name is not an owner-tier row", () => {
    expect(rowsOf(["products/factory/src/shepherd/g10-release.test.ts"])).toEqual([]);
  });

  it("a budget-class CI change skips the CI workflow row and keeps the others", () => {
    expect(rowsOf([".github/workflows/ci.yml", "products/factory/src/config.ts"], true)).toEqual(["settings file products/factory/src/config.ts"]);
  });

  it("a gate-resolve file raises the recorded tier to high, so the tier and the gate agree", () => {
    const risk = riskTier(riskFactsOf({ paths: ["packages/workflow/src/runtime.ts"], changedLines: 3, unread: undefined, ownerHold: undefined }));
    expect(risk.reasons).toContain("high: gate-resolve file packages/workflow/src/runtime.ts");
  });
});

describe("the owner-tier merge guard", () => {
  it("under on, a reviewed green head touching a merge-policy file gates on owner-tier, an authority-class row", async () => {
    const evidence = await evidenceFor(["products/factory/src/shepherd/g10-release.ts"], "on");
    const decision = decideAutoMerge(HEAD, evidence);
    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "owner-tier" } });
    expect(decision.reason).toBe("owner tier: merge-policy products/factory/src/shepherd/g10-release.ts");
    expect(decisionClassOf({ ...decision.rule, step: "approve-merge", prompt: "" })).toBe("D4");
    expect(evidence.record.ownerTier).toEqual({ mode: "on", rows: ["merge-policy products/factory/src/shepherd/g10-release.ts"] });
  });

  it("shadow allows and names the rows it would gate on", async () => {
    const evidence = await evidenceFor(["products/factory/src/shepherd/release.ts"], "shadow");
    const decision = decideAutoMerge(HEAD, evidence);
    expect(decision.outcome).toBe("allow");
    expect(decision.reason).toContain("; owner tier would gate: hold-command products/factory/src/shepherd/release.ts");
    expect(evidence.record.ownerTier).toEqual({ mode: "shadow", rows: ["hold-command products/factory/src/shepherd/release.ts"] });
  });

  it("a route that lost its wiring passes no mode, which fails closed as on", async () => {
    const evidence = await evidenceFor(["products/factory/src/shepherd/release.ts"], undefined);
    expect(evidence.ownerTier?.mode).toBe("on");
    expect(decideAutoMerge(HEAD, evidence)).toMatchObject({ outcome: "gate", rule: { rowId: "owner-tier" } });
  });

  it("off stamps nothing and allows", async () => {
    const evidence = await evidenceFor(["products/factory/src/shepherd/release.ts"], "off");
    expect(evidence.ownerTier).toBeUndefined();
    expect(evidence.record.ownerTier).toBeUndefined();
    const decision = decideAutoMerge(HEAD, evidence);
    expect(decision.outcome).toBe("allow");
    expect(decision.reason).not.toContain("owner tier");
  });

  it("under on, a head touching none of the rows allows", async () => {
    const evidence = await evidenceFor([PLAIN], "on");
    expect(decideAutoMerge(HEAD, evidence).outcome).toBe("allow");
    expect(evidence.record.ownerTier).toEqual({ mode: "on", rows: [] });
  });

  it("a stored on-stamp gates at decide time; an unstamped record decides as off", async () => {
    const shadowed = await evidenceFor(["packages/workflow/src/runtime.ts"], "shadow");
    const stored: DecidableEvidence = JSON.parse(JSON.stringify({ ...shadowed, ownerTier: { mode: "on", rows: [] } }));
    expect(decideAutoMerge(HEAD, stored)).toMatchObject({ outcome: "gate", rule: { rowId: "owner-tier" }, reason: "owner tier: gate-resolve-actor packages/workflow/src/runtime.ts" });
    expect(decideAutoMerge(HEAD, { ...stored, ownerTier: undefined }).outcome).toBe("allow");
  });

  it("a stamp with an unknown mode reads as on", async () => {
    const evidence = await evidenceFor(["products/factory/src/config.ts"], "shadow");
    const stored: DecidableEvidence = JSON.parse(JSON.stringify({ ...evidence, ownerTier: { mode: "later", rows: [] } }));
    expect(decideAutoMerge(HEAD, stored)).toMatchObject({ outcome: "gate", rule: { rowId: "owner-tier" } });
  });

  it("under on, a measured budget-class CI change stays on its coordinator row, not owner-tier", async () => {
    const evidence = await evidenceFor([".github/workflows/ci.yml"], "on");
    const budget: DecidableEvidence = { ...evidence, ciPolicy: { kind: "weakened", keys: ["other"] }, ciPolicyClass: { kind: "budget", measurement: "https://example.test/run/1" } };
    expect(decideAutoMerge(HEAD, budget).rule.rowId).toBe("ci-policy-budget");
    const weakening: DecidableEvidence = { ...budget, ciPolicyClass: { kind: "weakening", why: "a required check is removed" } };
    expect(decideAutoMerge(HEAD, weakening)).toMatchObject({ rule: { rowId: "owner-tier" }, reason: "owner tier: CI workflow file .github/workflows/ci.yml" });
  });
});

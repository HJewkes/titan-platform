import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { fakeLocator } from "../test-support/fakes.js";
import type { AttestVerdicts } from "./attest-evidence.js";
import { decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type DecidableEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import { authorityLineOf } from "./owner-tier.js";
import type { KindRead } from "./registered-kind.js";
import { ownerTierRows } from "./risk-tier.js";

const HEAD = fakeSha("authority-line-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const ADVERSARY = { agentId: "agent-adv-1", sessionId: "session-adv-1" };
const PLAIN = "packages/demo/src/plain.ts";
const HELD = "g10-adversary: security touch";

const adversaryMerge = (authority?: "unchanged" | "tightened" | "widened"): AttestVerdicts => ({
  attests: [],
  adversary: { reviewer: ADVERSARY, head: HEAD, attests: [], ...(authority && { authority }) },
  adversaryPlanned: true,
});

const input: MergeEvidenceInput = {
  ...{ runId: "run-1", repo: "octo/demo", pr: 1, head: HEAD, seatGrants: ["merge-on-green-approve"] },
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
};

/** A reviewed MERGE at HEAD with green checks, read under ownerTier on with the given attest verdicts and registration read. */
async function evidenceFor(attest: AttestVerdicts | undefined, kind: KindRead) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("authority-line-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [{ path: PLAIN, status: "modified" }]);
  return mergeEvidence(githubPort(fake.wire), { ...input, ...(attest && { attest }) }, noFreezeStoreUntilTp523, kind, undefined, { ownerTier: "on" });
}

describe("authorityLineOf", () => {
  it("reads the adversary's value when the panel planned an adversary", () => {
    expect(authorityLineOf(adversaryMerge("tightened"), { holdReason: HELD })).toEqual({ authorityLine: "tightened" });
  });

  it("a planned adversary that carried no value reads missing", () => {
    expect(authorityLineOf(adversaryMerge(), {})).toEqual({ authorityLine: "missing" });
  });

  it("a g10-adversary hold with no adversary member reads missing", () => {
    expect(authorityLineOf(undefined, { holdReason: HELD })).toEqual({ authorityLine: "missing" });
  });

  it("an unreadable registration reads missing", () => {
    expect(authorityLineOf(undefined, { unread: "the registered kind is unreadable: store unreadable: Error" })).toEqual({ authorityLine: "missing" });
  });

  it("a run that owes no adversary records nothing, whatever its hold", () => {
    expect(authorityLineOf(undefined, { holdReason: "g10-review: authority touch" })).toEqual({});
    expect(authorityLineOf(undefined, undefined)).toEqual({});
  });
});

describe("the Authority rows", () => {
  it("widened and missing are owner-tier rows; unchanged and tightened add nothing", () => {
    expect(ownerTierRows({ paths: [PLAIN], ciBudget: false, authorityLine: "widened" })).toEqual(["Authority widened"]);
    expect(ownerTierRows({ paths: [PLAIN], ciBudget: false, authorityLine: "missing" })).toEqual(["Authority line missing"]);
    expect(ownerTierRows({ paths: [PLAIN], ciBudget: false, authorityLine: "unchanged" })).toEqual([]);
    expect(ownerTierRows({ paths: [PLAIN], ciBudget: false, authorityLine: "tightened" })).toEqual([]);
  });

  it("the evidence step stamps the line on the record and the evidence it returns", async () => {
    const evidence = await evidenceFor(adversaryMerge("widened"), { holdReason: HELD });

    expect(evidence.authorityLine).toBe("widened");
    expect(evidence.record).toMatchObject({ authorityLine: "widened", ownerTier: { mode: "on", rows: ["Authority widened"] }, riskTier: { tier: "high" } });
    expect(decideAutoMerge(HEAD, evidence)).toMatchObject({ outcome: "gate", rule: { rowId: "owner-tier" }, reason: "owner tier: Authority widened" });
  });

  it("a stored stamp decides at decide time, and an unknown stamped value reads missing", async () => {
    const evidence = await evidenceFor(adversaryMerge("unchanged"), { holdReason: HELD });
    const stored = (authorityLine: unknown): DecidableEvidence => JSON.parse(JSON.stringify({ ...evidence, authorityLine }));

    expect(decideAutoMerge(HEAD, evidence).outcome).toBe("allow");
    expect(decideAutoMerge(HEAD, stored("widened"))).toMatchObject({ outcome: "gate", reason: "owner tier: Authority widened" });
    expect(decideAutoMerge(HEAD, stored("sort of widened"))).toMatchObject({ outcome: "gate", reason: "owner tier: Authority line missing" });
  });
});

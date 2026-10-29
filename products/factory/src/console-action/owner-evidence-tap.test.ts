import { describe, expect, it } from "vitest";
import { BEFORE_OPEN, H, REPO, evidence, evidenceStep, gateOn, reads, verdictText, weakened } from "../test-support/owner-evidence.js";
import { resolveGate } from "./gate.js";
import { ownerEvidence } from "./owner-evidence.js";

/** TP-4404: a console tap on an owner-at-head merge gate resolves only on the digest of the card the owner was shown. */
const H2 = "c".repeat(40);
const CONFIRM = `action:${"d".repeat(64)}`;
const TEXT = verdictText("CI-policy: weakened secrets");

const tap = (gateId: string, headSha: string, evidenceDigest?: string) => ({
  action: { kind: "resolve-gate" as const, gateId, runId: gateId.slice(0, gateId.indexOf("/")), stepId: "approve-merge", repo: REPO, pr: 1, headSha, decision: "merge", ...(evidenceDigest !== undefined && { evidenceDigest }) },
  confirmEvent: CONFIRM,
});

async function weakenedGate() {
  const stored = evidence(weakened("secrets"));
  const world = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
  const card = await ownerEvidence(world.gate, { host: world.host, port: world.port, readText: reads(TEXT) });
  return { ...world, digest: card.status === "ready" ? card.digest : undefined };
}

describe("a console tap on an owner-at-head gate", () => {
  it("merges at the pinned head on the digest of the card shown, naming the facts it covered", async () => {
    const { host, port, gate, digest } = await weakenedGate();

    const outcome = await resolveGate(tap(gate.id, H, digest), port, host, reads(TEXT));

    expect(outcome).toEqual({ outcome: "resolved", gateId: gate.id, covered: ["ci-policy-weakened"] });
    expect(host.gates.get(gate.id)).toMatchObject({ status: "resolved", payload: { decision: "merge", headSha: H }, resolvedBy: { class: "owner-remote", confirmEvent: CONFIRM } });
  });

  it("refuses a digest of another card, so evidence that changed after the owner read it never merges", async () => {
    const { host, port, gate } = await weakenedGate();

    const outcome = await resolveGate(tap(gate.id, H, "e".repeat(64)), port, host, reads(TEXT));

    expect(outcome).toMatchObject({ outcome: "refused", reason: "evidence", detail: `the evidence for ${gate.id} changed since it was shown; read the item again` });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });

  it("refuses a tap with no digest, naming the terminal command", async () => {
    const { host, port, gate } = await weakenedGate();

    const outcome = await resolveGate(tap(gate.id, H), port, host, reads(TEXT));

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining(`which the console answers only with its evidence shown; run titan-factory gate resolve ${gate.id.replace("/", " ")}`) });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });

  it("reads a tap at a head other than the gate's as moved, even when the PR is now at that head", async () => {
    const { host, fake, port, gate, digest } = await weakenedGate();
    fake.pushHead(1, H2);

    const outcome = await resolveGate(tap(gate.id, H2, digest), port, host, reads(TEXT));

    expect(outcome).toEqual({ outcome: "moved", currentHead: H });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });

  it("refuses a digest on a gate that asks for no evidence as a record fault", async () => {
    const stored = evidence();
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)], "shepherd-merge-guard/reviewed-merge");

    const outcome = await resolveGate(tap(gate.id, H, "e".repeat(64)), port, host, reads(TEXT));

    expect(outcome).toMatchObject({ outcome: "refused", reason: "record", detail: `${gate.id} asks for no evidence, yet the record carries a digest` });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });
});

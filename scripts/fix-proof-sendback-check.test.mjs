import { describe, expect, it } from "vitest";
import { checkSendBack } from "./fix-proof-sendback-check.mjs";

const H = "b".repeat(40);
const OLD = "a".repeat(40);

const step = (stepId, status = "done") => ({ kind: "step", stepId, iteration: 0, startedAt: null, completedAt: status === "done" ? "2026-10-14T00:00:00Z" : null, signal: null, status });
const wake = (stepId, request = null) => ({ kind: "wake", stepId, request, outcome: "woken", agent: "tc-tp-538-a", mode: "live", sessionId: null });
const verdict = (value) => ({ kind: "verdict", stepId: `sh-await-verdict:${H}`, verdict: value, headSha: H, locator: null, reviewer: "rv-1" });

const proof = (head = H, status = "done") => step(`sh-fix-proof:${head}`, status);
const sentBack = () => [step("sh-wake-fix-proof"), wake("sh-wake-implementer:0")];

describe("checkSendBack", () => {
  it("passes when the proof at the head is followed by a fix-proof wake of the implementer and no review", () => {
    expect(checkSendBack([step("ci-wait:0"), proof(), ...sentBack()], H)).toEqual({ ok: true, pending: false, failures: [] });
  });

  it("fails naming a reviewer spawn when an sh-review step follows the proof", () => {
    const result = checkSendBack([proof(), step(`sh-review:${H}`), ...sentBack()], H);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`reviewer spawned after the proof: step sh-review:${H}`]);
  });

  it("fails when a MERGE verdict follows the proof", () => {
    const result = checkSendBack([proof(), ...sentBack(), verdict("MERGE")], H);

    expect(result).toMatchObject({ ok: false, pending: false });
    expect(result.failures[0]).toMatch(/reviewer spawned after the proof: verdict/);
  });

  it("does not take a proof at an older head as the proof at this head", () => {
    expect(checkSendBack([proof(OLD), ...sentBack()], H)).toMatchObject({ ok: false, pending: true });
  });

  it("fails when the wake is a FIX_FIRST review wake rather than a fix-proof one", () => {
    const result = checkSendBack([proof(), step("sh-wake-fix-first"), wake("sh-wake-fix-first", "review"), wake("sh-wake-implementer:0")], H);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("review-kind wake after the proof: sh-wake-fix-first");
  });

  it("fails when the fix-proof wake was recorded before the proof at this head", () => {
    const result = checkSendBack([...sentBack(), proof()], H);

    expect(result).toMatchObject({ ok: false, pending: false });
    expect(result.failures).toEqual(["fix-proof wake recorded before the proof at this head, none after it"]);
  });

  it("allows reviews at an older head before the PR is sent back at its new head", () => {
    const earlier = [step(`sh-review-intent:${OLD}`), step(`sh-review:${OLD}`), { ...verdict("FIX_FIRST"), stepId: `sh-await-verdict:${OLD}`, headSha: OLD }];

    expect(checkSendBack([...earlier, proof(), ...sentBack()], H).ok).toBe(true);
  });

  it("allows a fix-proof wake that answered an older head's proof", () => {
    expect(checkSendBack([proof(OLD), ...sentBack(), proof(), ...sentBack()], H).ok).toBe(true);
  });

  it("reads a running proof step as pending, not as a pass or a failure", () => {
    expect(checkSendBack([proof(H, "running")], H)).toEqual({ ok: false, pending: true, failures: [] });
  });

  it("stays pending while the proof is done but its wake is not yet recorded", () => {
    expect(checkSendBack([proof()], H)).toEqual({ ok: false, pending: true, failures: [] });
  });
});

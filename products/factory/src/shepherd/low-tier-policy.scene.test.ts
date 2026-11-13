import type { GitHubWire } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { HEAD } from "./plan-approval.scene.test-helpers.js";
import { WAKE_LOOP, changed, heldRun, stillHeldAfterMerge, timeline } from "./low-tier-policy.scene.test-helpers.js";

/**
 * TP-5403 (owner triage q28 A): a policy touch that is low tier by its paths lands on the seat opus reviewer's MERGE at its head
 * with green CI, with no owner gate, once the owner sets `lowTierPolicy: on`. Authority, security, publish and settings
 * touches, and a file list that cannot be read, are still held for the adversary: one opus MERGE releases none of them.
 * Each scene runs the real shepherd-pr workflow.
 */
const failingFileList = (wire: GitHubWire): GitHubWire => ({ ...wire, listPrFiles: () => Promise.reject(new Error("file list read failed")) });

describe("a low-tier policy touch", () => {
  it("merges on the seat opus MERGE at its head with green CI and no approve-merge gate", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP), { lowTier: "on" });

    await vi.waitFor(() => expect(run.fake.effects.merge).toBe(1), { timeout: 20_000 });

    expect(held).toBe("g10-review: low-tier policy touch (hold-closure)");
    expect(run.approveMerge()).toBeUndefined();
    expect(run.host.gates.listPending()).toEqual([]);
    expect(run.store.get().eventsOf(run.runId)).toContainEqual(expect.objectContaining({ kind: "release", reason: held, actor: "shepherd", headSha: HEAD }));
    expect(timeline(run)).toContainEqual(expect.objectContaining({ kind: "decision", rule: "g10-review/low-tier", head: HEAD }));
  });
});

describe("a policy touch kept from low tier", () => {
  it("an authority touch is still held for the adversary and the owner", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP, "packages/authority/src/evaluate.ts"));

    expect(held).toBe("g10-adversary: authority, policy touch (kept: authority touch)");
    await stillHeldAfterMerge(run);
  });

  it("a security touch is still held for the adversary and the owner", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP, "packages/tool-guard/src/index.ts"));

    expect(held).toBe("g10-adversary: policy, security touch (kept: security touch)");
    await stillHeldAfterMerge(run);
  });

  it("a publish touch is still held for the adversary and the owner", async () => {
    const { held, run } = await heldRun(changed("products/factory/src/shepherd/version-packages.ts"));

    expect(held).toBe("g10-adversary: policy touch (kept: high: publish file products/factory/src/shepherd/version-packages.ts)");
    await stillHeldAfterMerge(run);
  });

  it("a settings touch is still held for the adversary and the owner", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP, ".github/merge-lint.json"));

    expect(held).toBe("g10-adversary: policy touch (kept: medium: .github path .github/merge-lint.json)");
    await stillHeldAfterMerge(run);
  });

  it("an unread file list fails closed to the adversary hold", async () => {
    const { held, run } = await heldRun(changed(WAKE_LOOP), { wire: failingFileList });

    expect(held).toBe("g10-adversary: changed files unread at registration (Error)");
    await stillHeldAfterMerge(run);
  });
});

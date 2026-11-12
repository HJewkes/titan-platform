import type { PrFile } from "@titan-design/github";
import { GateResolverRefused, type GateRecord, type GateResolver } from "@titan-design/hitl";
import { describe, expect, it, vi } from "vitest";
import { coordinatorEvidencePolicy, landGate, type CoordinatorEvidence } from "../coordinator-evidence.js";
import { evidenceMarker } from "./evidence-comment.js";
import type { OwnerTierMode } from "./owner-tier.js";
import { AUTO, HEAD, PR, plannedRun } from "./plan-approval.scene.test-helpers.js";

/**
 * TP-5406 (gate model S2): under `shepherd.gateReset.ownerTier: on`, a reviewed green PR touching a file on the owner's
 * merge stop list raises approve-merge on the owner-tier guard row. Under shadow, the default, it merges as before and
 * its evidence records the rows it would have gated on. Each scene runs the real shepherd-pr workflow on a fake GitHub.
 */
const ROW_FIXTURES = [
  ["a merge-policy file", "products/factory/src/shepherd/g10-release.ts"],
  ["a hold-command file", "products/factory/src/shepherd/release.ts"],
  ["an owner-action file", ".github/fix-proof.json"],
  ["a gate-resolve-actor file", "packages/workflow/src/runtime.ts"],
  ["a gate-resolve-check file", "products/factory/src/shepherd/gate-resolve-sites.test.ts"],
  ["a CI workflow file", ".github/workflows/ci.yml"],
  ["a publish file", "products/factory/src/shepherd/version-packages.ts"],
  ["a settings file", "products/factory/src/config.ts"],
] as const;

const PLAIN = "packages/demo/src/plain.ts";
const COORDINATOR: GateResolver = { class: "coordinator", id: "tc-synthetic-coord", channel: "factory-cli" };
const MERGE = { decision: "merge", headSha: HEAD };

const changed = (...paths: string[]): PrFile[] => paths.map((path) => ({ path, status: "modified", additions: 4, deletions: 1 }));

/** The G10 hold a policy touch draws, released by its seat at the head, so only the merge guard stands between the MERGE and a merge. */
const SEAT_RELEASED = "g10-adversary: policy touch";

/** A `.github/` change needs the reviewer's CI-policy line, so every scene's MERGE carries one. */
const run = (files: PrFile[], ownerTier?: OwnerTierMode) =>
  plannedRun({ files, policy: AUTO, reviewerLines: "CI-policy: unchanged", approve: () => undefined, seatReleased: SEAT_RELEASED, ...(ownerTier && { ownerTier }) }, () => undefined);

async function gatedOn(scene: ReturnType<typeof run>): Promise<GateRecord> {
  await vi.waitFor(() => expect(scene.approveMerge()).toBeDefined(), { timeout: 20_000 });
  return scene.approveMerge()!;
}

/** The machine evidence the run posted at HEAD, read back from its PR comment. */
function postedEvidence(scene: ReturnType<typeof run>): Record<string, unknown> {
  const body = scene.fake.comments.get(PR)?.find((comment) => comment.body.includes(evidenceMarker(HEAD)))?.body ?? "";
  return JSON.parse(body.split("```json\n")[1]!.split("\n```")[0]!) as Record<string, unknown>;
}

describe("under ownerTier on", () => {
  it.each(ROW_FIXTURES)("a reviewed green PR touching %s raises approve-merge on owner-tier", async (_row, path) => {
    const scene = run(changed(path, PLAIN), "on");

    const gate = await gatedOn(scene);

    expect(gate.prompt).toContain("Policy shepherd-merge-guard/owner-tier: ");
    expect(gate.prompt).toContain(path);
    expect(scene.fake.effects.merge).toBe(0);
  });

  it("a feature PR touching none of the rows merges with no approve-merge gate", async () => {
    const scene = run(changed(PLAIN), "on");

    await vi.waitFor(() => expect(scene.fake.effects.merge).toBe(1), { timeout: 20_000 });

    expect(scene.approveMerge()).toBeUndefined();
  });

  it("the owner-tier gate is not resolvable by the coordinator delegate", async () => {
    const scene = run(changed("products/factory/src/shepherd/g10-release.ts"), "on");
    const gate = await gatedOn(scene);
    const land = landGate(gate)!;
    const runs = ["validate", "dag-check"].map((name, i) => ({ id: i + 1, name, conclusion: "success", headSha: HEAD }));
    const evidence: CoordinatorEvidence = {
      ...{ kind: "approve-merge", gateId: gate.id, repo: land.repo, pr: land.pr, headSha: HEAD, readAt: "2026-11-12T13:00:00.000Z" },
      ...{ run: { workflow: "shepherd-pr", repo: land.repo, pr: land.pr, rule: land.rule, reason: land.reason, merge: "auto", visualPaths: false, held: false, frozen: false } },
      ...{ checks: { base: "main", required: ["validate", "dag-check"], runs }, verdict: { step: `sh-await-verdict:${HEAD}`, verdict: "MERGE", head: HEAD, reviewer: "rv-synthetic" } },
      ...{ pull: { state: "open", headSha: HEAD, mergeableState: "clean", mergeable: "MERGEABLE" } },
    };

    expect(land.rule).toBe("shepherd-merge-guard/owner-tier");
    expect(gate.rule).toBeUndefined();
    expect(coordinatorEvidencePolicy(gate, COORDINATOR, MERGE, evidence)).toBe(false);
    expect(() => scene.host.gates.resolve(gate.id, MERGE, COORDINATOR, evidence)).toThrow(GateResolverRefused);
    expect(scene.host.gates.get(gate.id)?.status).toBe("pending");
    expect(scene.fake.effects.merge).toBe(0);
  });
});

describe("under ownerTier shadow", () => {
  it.each([["set to shadow", "shadow"], ["left unset", undefined]] as const)("with the flag %s, the same PR merges on MRG-AU-RV and its evidence records the rows", async (_how, mode) => {
    const scene = run(changed("products/factory/src/shepherd/g10-release.ts", PLAIN), mode);

    await vi.waitFor(() => expect(scene.fake.effects.merge).toBe(1), { timeout: 20_000 });

    expect(scene.approveMerge()).toBeUndefined();
    const posted = postedEvidence(scene);
    expect(posted.ownerTier).toEqual({ mode: "shadow", rows: ["merge-policy products/factory/src/shepherd/g10-release.ts"] });
    expect(posted.decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect((posted.decision as { reason: string }).reason).toContain("; owner tier would gate: merge-policy products/factory/src/shepherd/g10-release.ts");
  });
});

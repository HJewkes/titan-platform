import type { PrFile } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { evidenceMarker } from "./evidence-comment.js";
import type { OwnerTierMode } from "./owner-tier.js";
import { AUTO, HEAD, PR, plannedRun } from "./plan-approval.scene.test-helpers.js";

/**
 * TP-5407 (gate model S3b): the adversary's `Authority:` line reaches the owner-tier row. Each scene runs the real
 * shepherd-pr workflow on a fake GitHub with a g10-adversary hold, so the panel plans an adversary member beside correctness
 * and the hold releases on their two MERGEs. Under `ownerTier: on`, widened or missing stops for the owner at merge.
 */
const SECURITY = "packages/tool-guard/src/deny-rules.ts";
const PLAIN = "packages/demo/src/plain.ts";
const HELD = "g10-adversary: security touch";
const ROLES = { g10: "bd-reviewer", standard: "reviewer" } as const;

const changed = (...paths: string[]): PrFile[] => paths.map((path) => ({ path, status: "modified", additions: 4, deletions: 1 }));
const adversaryLines = (authority: string) => `Probes: a quoted git word -> denied\nAuthority: ${authority}\n`;

/** A g10-adversary run whose two reviewers both write `above`; `holdMember: false` leaves the hold with no adversary member planned. */
const heldRun = (above: string, ownerTier: OwnerTierMode, { holdMember = true } = {}) =>
  plannedRun(
    { files: changed(SECURITY), policy: AUTO, reviewerLines: "", aboveVerdict: above, approve: () => undefined, held: HELD, roles: ROLES, ownerTier, ...(holdMember && { holdMember: true as const }) },
    () => undefined,
  );

type Scene = ReturnType<typeof heldRun>;

/** The machine evidence the run posted at HEAD, read back from its PR comment. */
function postedEvidence(scene: Scene): Record<string, unknown> {
  const body = scene.fake.comments.get(PR)?.find((comment) => comment.body.includes(evidenceMarker(HEAD)))?.body ?? "";
  const posted: Record<string, unknown> = JSON.parse(body.split("```json\n")[1]!.split("\n```")[0]!);
  return posted;
}

const releaseRule = (scene: Scene): unknown =>
  Object.values(scene.host.runtime.status(scene.runId)!.stepResults).find((result) => result.stepId.startsWith("sh-g10-release:"))?.data?.result;

async function mergedClear(scene: Scene): Promise<void> {
  await vi.waitFor(() => expect(scene.fake.effects.merge).toBe(1), { timeout: 20_000 });
  expect(scene.approveMerge()).toBeUndefined();
}

async function gatedOnOwnerTier(scene: Scene, row: string): Promise<void> {
  await vi.waitFor(() => expect(scene.approveMerge()).toBeDefined(), { timeout: 20_000 });
  expect(scene.approveMerge()?.prompt).toContain(`Policy shepherd-merge-guard/owner-tier: `);
  expect(scene.approveMerge()?.prompt).toContain(row);
  expect(scene.fake.effects.merge).toBe(0);
}

describe("under ownerTier on", () => {
  it("an adversary MERGE reading Authority: unchanged merges on two MERGEs with no owner gate", async () => {
    const scene = heldRun(adversaryLines("unchanged"), "on");

    await mergedClear(scene);

    expect(releaseRule(scene)).toMatchObject({ released: true, rule: "g10-adversary/two-merge" });
    expect(postedEvidence(scene)).toMatchObject({ authorityLine: "unchanged", ownerTier: { mode: "on", rows: [] } });
  });

  it("Authority: tightened merges with no owner gate", async () => {
    const scene = heldRun(adversaryLines("tightened"), "on");

    await mergedClear(scene);

    expect(postedEvidence(scene)).toMatchObject({ authorityLine: "tightened", ownerTier: { mode: "on", rows: [] } });
  });

  it("Authority: widened raises approve-merge on owner-tier", async () => {
    const scene = heldRun(adversaryLines("widened"), "on");

    await gatedOnOwnerTier(scene, "Authority widened");

    expect(postedEvidence(scene)).toMatchObject({ authorityLine: "widened", riskTier: { tier: "high", reasons: expect.arrayContaining(["high: Authority widened"]) } });
  });

  it("an adversary hold with no Authority value raises approve-merge on owner-tier", async () => {
    const scene = heldRun(adversaryLines("unchanged"), "on", { holdMember: false });

    await gatedOnOwnerTier(scene, "Authority line missing");

    expect(postedEvidence(scene)).toMatchObject({ authorityLine: "missing", ownerTier: { mode: "on", rows: ["Authority line missing"] } });
  });

  it("a PR with no adversary required records no Authority fact and no gate", async () => {
    const scene = plannedRun({ files: changed(PLAIN), policy: AUTO, reviewerLines: "", approve: () => undefined, ownerTier: "on" }, () => undefined);

    await mergedClear(scene);

    expect(postedEvidence(scene)).not.toHaveProperty("authorityLine");
    expect(postedEvidence(scene)).toMatchObject({ ownerTier: { mode: "on", rows: [] } });
  });
});

describe("under ownerTier shadow", () => {
  it("widened merges and its evidence records the would-gate", async () => {
    const scene = heldRun(adversaryLines("widened"), "shadow");

    await mergedClear(scene);

    expect(postedEvidence(scene)).toMatchObject({
      authorityLine: "widened",
      ownerTier: { mode: "shadow", rows: ["Authority widened"] },
      decision: { outcome: "allow", rule: { rowId: "MRG-AU-RV" }, reason: expect.stringContaining("; owner tier would gate: Authority widened") },
    });
  });
});

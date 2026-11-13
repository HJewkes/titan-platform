import { fakeSha } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { BRANCH, callCommand, shepherdFixture } from "../test-support/shepherd.js";
import { supersedeMovedGates } from "./head-moved.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";
import { sweepVersionPackages } from "./version-packages.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const NOW = Date.parse("2026-01-01T12:00:00Z");
const BASE = fakeSha("release-base");
const WIDGET = "packages/widget/package.json";
const WIDGET_LOG = "packages/widget/CHANGELOG.md";
/** Synthetic stand-ins for #1970's first gated head and the head changesets regenerated after a changeset-carrying merge. */
const GATED = fakeSha("release-gated");
const REGENERATED = fakeSha("release-regenerated");

/** A watched repo whose Version Packages PR bumps one public package, its release run parked on the owner's gate at GATED. */
async function gatedRelease() {
  const fixture = shepherdFixture();
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  const envelope = await callCommand(host, fixture.routes, "shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" });
  if (!envelope.ok) throw new Error(envelope.error);
  const vp = fixture.fake.addPr({ headSha: GATED, headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO }).number;
  fixture.fake.prFiles.set(vp, [
    { path: WIDGET, status: "modified" },
    { path: WIDGET_LOG, status: "modified" },
    { path: ".changeset/widget-fix.md", status: "removed" },
  ]);
  fixture.fake.files.set(`${BASE}:${WIDGET}`, { content: JSON.stringify({ name: "@demo/widget", version: "1.0.0" }), blobSha: "w0" });
  const versionAt = (head: string, version: string) => {
    fixture.fake.compares.set(`main...${head}`, { mergeBaseSha: BASE, files: [] });
    fixture.fake.files.set(`${head}:${WIDGET}`, { content: JSON.stringify({ name: "@demo/widget", version }), blobSha: `w-${version}` });
  };
  versionAt(GATED, "1.1.0");
  await sweepVersionPackages(host, fixture.routes.shepherd!, () => NOW);
  const runId = fixture.routes.shepherd!.store.get().byPr(REPO, vp)!.runId;
  const gate = gateId(runId, "approve-merge");
  await gateOpened(host, gate);
  return { ...fixture, host, vp, runId, gate, versionAt };
}

function resultOf(w: { host: FactoryHost; runId: string }, stepId: string): unknown {
  return Object.values(w.host.runtime.status(w.runId)!.stepResults).find((step) => step.stepId === stepId)?.data?.result;
}

describe("an owner release gate across a changesets re-head (TP-5591)", () => {
  it("asks the owner under the release table's owner row", async () => {
    const w = await gatedRelease();

    expect(w.host.gates.get(w.gate)?.prompt).toContain(`at head ${GATED}`);
    expect(w.host.gates.get(w.gate)?.prompt).toContain("Policy shepherd-release/owner-gate:");
  });

  it("keeps the gate pending over a head that only regenerates release files, and the owner's answer merges the new head", async () => {
    const w = await gatedRelease();
    w.versionAt(REGENERATED, "1.2.0");
    w.fake.pushHead(w.vp, REGENERATED);

    const superseded = await supersedeMovedGates(w.host, w.routes.shepherd!);
    const pendingAfterSweep = w.host.gates.get(w.gate)?.status;
    w.host.gates.resolve(w.gate, { decision: "merge", headSha: GATED }, OWNER);
    await vi.waitFor(() => expect(resultOf(w, "sh-landed")).toBeDefined(), { timeout: 10_000 });

    expect(superseded).toEqual([]);
    expect(pendingAfterSweep).toBe("pending");
    expect(resultOf(w, "sh-landed")).toMatchObject({ pr: w.vp, headSha: REGENERATED });
    expect(resultOf(w, `sh-approval-carry:${REGENERATED}`)).toMatchObject({ decision: "merge", headSha: REGENERATED, fromHead: GATED, rule: "release-regenerated" });
    expect(w.host.gates.get(gateId(w.runId, "approve-merge", 1))).toBeUndefined();
  });

  it("cancels the gate as before when the new head changes a file a release does not write", async () => {
    const w = await gatedRelease();
    w.versionAt(REGENERATED, "1.2.0");
    w.fake.prFiles.set(w.vp, [...w.fake.prFiles.get(w.vp)!, { path: "packages/widget/src/index.ts", status: "modified" }]);
    w.fake.pushHead(w.vp, REGENERATED);

    const superseded = await supersedeMovedGates(w.host, w.routes.shepherd!);

    expect(superseded).toEqual([{ runId: w.runId, gateId: w.gate, from: GATED, to: REGENERATED, condition: "head-moved" }]);
    expect(w.host.gates.get(w.gate)?.status).toBe("cancelled");
  });

  it("cancels the gate when the new head is no longer changesets' own branch", async () => {
    const w = await gatedRelease();
    w.versionAt(REGENERATED, "1.2.0");
    w.fake.pushHead(w.vp, REGENERATED);
    w.fake.pr(w.vp).headRepo = "someone/fork";

    const superseded = await supersedeMovedGates(w.host, w.routes.shepherd!);

    expect(superseded).toMatchObject([{ gateId: w.gate, condition: "head-moved" }]);
  });
});

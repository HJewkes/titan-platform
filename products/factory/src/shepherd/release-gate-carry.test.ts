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
const BLOCKED = fakeSha("release-blocked");
/** Synthetic logins: the configured release App's bot, and any other account that can push to the branch. */
const RELEASE_BOT = "demo-release[bot]";
const FOREIGN = "branch-pusher";

/** A watched repo whose Version Packages PR bumps one public package, its release run parked on the owner's gate at GATED. */
/** `null` configures no release App login. */
async function gatedRelease(releaseAppLogin: string | null = RELEASE_BOT) {
  const fixture = shepherdFixture(releaseAppLogin === null ? {} : { releaseAppLogin });
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
  const versionAt = (head: string, version: string, author: string = RELEASE_BOT) => {
    fixture.fake.commitLogins.set(head, { author, committer: "web-flow" });
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

type Gated = Awaited<ReturnType<typeof gatedRelease>>;

/** A head whose PR files are all release files, so the sweep keeps the gate, but whose manifest adds `scripts`, which the preflight blocks. */
function reheadWithScriptsEdit(w: Gated, head: string): void {
  w.versionAt(head, "1.2.0");
  w.fake.files.set(`${head}:${WIDGET}`, { content: JSON.stringify({ name: "@demo/widget", version: "1.2.0", scripts: { postinstall: "node setup.js" } }), blobSha: "w-scripts" });
  w.fake.pushHead(w.vp, head);
}

function ownerGateAt(w: Gated, head: string) {
  return w.host.pendingGates().find((pending) => pending.runId === w.runId && pending.gate.prompt.includes(`at head ${head}`))?.gate;
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

  it("asks the owner fresh at a kept head whose manifest edit fails the full preflight", async () => {
    const w = await gatedRelease();
    reheadWithScriptsEdit(w, BLOCKED);

    const superseded = await supersedeMovedGates(w.host, w.routes.shepherd!);
    w.host.gates.resolve(w.gate, { decision: "merge", headSha: GATED }, OWNER);
    await gateOpened(w.host, gateId(w.runId, "approve-merge", 1), 10_000);

    expect(superseded).toEqual([]);
    expect(w.host.gates.get(gateId(w.runId, "approve-merge", 1))?.prompt).toContain(`at head ${BLOCKED}`);
    expect(w.host.gates.get(gateId(w.runId, "approve-merge", 1))?.prompt).toContain("Policy shepherd-release/preflight-blocked:");
    expect(resultOf(w, `sh-approval-carry:${BLOCKED}`)).toBeUndefined();
    expect(resultOf(w, "sh-landed")).toBeUndefined();
  });

  it("ends the carry at a blocked gate the owner never answered, so a later passing head asks again", async () => {
    const w = await gatedRelease();
    reheadWithScriptsEdit(w, BLOCKED);
    await supersedeMovedGates(w.host, w.routes.shepherd!);
    w.host.gates.resolve(w.gate, { decision: "merge", headSha: GATED }, OWNER);
    const blockedGate = gateId(w.runId, "approve-merge", 1);
    await gateOpened(w.host, blockedGate, 10_000);
    w.versionAt(REGENERATED, "1.2.0");
    w.fake.pushHead(w.vp, REGENERATED);

    const superseded = await supersedeMovedGates(w.host, w.routes.shepherd!);
    await vi.waitFor(() => expect(ownerGateAt(w, REGENERATED)).toBeDefined(), { timeout: 10_000 });

    expect(superseded).toMatchObject([{ gateId: blockedGate, from: BLOCKED, to: REGENERATED }]);
    expect(ownerGateAt(w, REGENERATED)?.prompt).toContain("Policy shepherd-release/owner-gate:");
    expect(resultOf(w, `sh-approval-carry:${REGENERATED}`)).toBeUndefined();
    expect(resultOf(w, "sh-landed")).toBeUndefined();
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

describe("the release App's authorship of a regenerated head (TP-5606)", () => {
  const unauthored: [string, string | null, string][] = [
    ["another account authored the head", RELEASE_BOT, FOREIGN],
    ["no release App login is configured", null, RELEASE_BOT],
  ];

  it.each(unauthored)("cancels the kept gate when %s", async (_scenario, configured, author) => {
    const w = await gatedRelease(configured);
    w.versionAt(REGENERATED, "1.2.0", author);
    w.fake.pushHead(w.vp, REGENERATED);

    const superseded = await supersedeMovedGates(w.host, w.routes.shepherd!);

    expect(superseded).toEqual([{ runId: w.runId, gateId: w.gate, from: GATED, to: REGENERATED, condition: "head-moved" }]);
    expect(w.host.gates.get(w.gate)?.status).toBe("cancelled");
  });

  it.each(unauthored)("asks the owner fresh instead of carrying the answer when %s", async (_scenario, configured, author) => {
    const w = await gatedRelease(configured);
    w.versionAt(REGENERATED, "1.2.0", author);
    w.fake.pushHead(w.vp, REGENERATED);

    w.host.gates.resolve(w.gate, { decision: "merge", headSha: GATED }, OWNER);
    await gateOpened(w.host, gateId(w.runId, "approve-merge", 1), 10_000);

    expect(ownerGateAt(w, REGENERATED)?.prompt).toContain("Policy shepherd-release/owner-gate:");
    expect(resultOf(w, `sh-release-author:${REGENERATED}`)).toEqual({ head: REGENERATED, released: false });
    expect(resultOf(w, `sh-approval-carry:${REGENERATED}`)).toBeUndefined();
    expect(resultOf(w, "sh-landed")).toBeUndefined();
  });

  it("carries the owner's answer to a head the release App authored, matching its login in any case", async () => {
    const w = await gatedRelease(RELEASE_BOT.toUpperCase());
    w.versionAt(REGENERATED, "1.2.0");
    w.fake.pushHead(w.vp, REGENERATED);

    w.host.gates.resolve(w.gate, { decision: "merge", headSha: GATED }, OWNER);
    await vi.waitFor(() => expect(resultOf(w, "sh-landed")).toBeDefined(), { timeout: 10_000 });

    expect(resultOf(w, `sh-release-author:${REGENERATED}`)).toEqual({ head: REGENERATED, released: true });
    expect(resultOf(w, "sh-landed")).toMatchObject({ pr: w.vp, headSha: REGENERATED });
  });
});

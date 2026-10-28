import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import type { ReviewAccounts } from "./account-limit.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { reviewPhase } from "./review.js";
import { shepherdStoreRef } from "./store.js";
import type { VisualThreshold } from "./visual-delta-read.js";
import { card } from "./visual-delta-read.test-helpers.js";

/**
 * TP-2662: a seat with visual paths and baselines lets a glob-matched head that changes no baseline merge on its green
 * baseline check, and asks the owner only when a baseline file changed. Proven over the real shepherd-pr run, so the run
 * policy has to carry the baselines all the way to the evidence step and the land decision.
 */
const REPO = "octo/design";
const PR = 12;
const HEAD = fakeSha("visual-head");
const COMPONENT = "packages/ui/src/components/Beat.tsx";
const BASELINE = "packages/ui/specimen/baseline/beat/default-chromium-linux.png";
const VISUAL_POLICY = `Policy shepherd-merge-guard/visual-path: `;
const MERGE_BASE = fakeSha("visual-merge-base");
const SNAPSHOT = "packages/ui/specimen/baseline/beat.screenshot.test.ts-snapshots/beat-card--default-chromium-linux.png";
const API_REPORT = "packages/ui/api/index.api.md";
const THRESHOLD_ON: VisualThreshold = {
  mode: "on",
  snapshotPaths: ["packages/ui/specimen/baseline/**/*-chromium-linux.png"],
  apiPaths: ["packages/ui/api/*.api.md"],
  tokenPaths: ["packages/ui/src/theme/tokens/**"],
  harnessPaths: ["packages/ui/playwright*.config.ts"],
};
const T0 = Date.parse("2026-10-26T12:00:00.000Z");
const MINUTE = 60_000;
const VISUAL: EffectivePolicy = {
  ...OWNER_GATE_POLICY,
  merge: "auto",
  fixer: true,
  seat: "design-seat",
  visualPaths: ["packages/ui/src/components/**", "**/*.png"],
  visualBaselines: { check: "visual", paths: ["packages/ui/specimen/baseline/**"] },
};

const locatorIn = (nativeId: string): SourceTextLocator => ({
  source: {
    ...{ sourceId: nativeId, harness: "claude-code", format: "jsonl", formatVersion: null, path: `${nativeId}.jsonl`, namespace: "test" },
    ...{ conversation: { harness: "claude-code", namespace: "test", nativeId }, provenance: { kind: "claude-code-transcript", legacySessionId: nativeId } },
  },
  evidence: { line: { sourceId: nativeId, byteOffset: 0, byteLength: 0, contentHash: "", lineNumber: null, nativeOrdinal: null }, subrecord: { index: 0, path: [] } },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Every spawn lands as a reviewer that says MERGE at the head it was asked about. */
function mergingReviewers(clock: () => number) {
  const agents: ReviewerAgent[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => void agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null }),
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => [
    { agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock() + 1, text: `Verdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n`, locator: locatorIn(input.reviewerSessionId) },
  ];
  const accounts: ReviewAccounts = { dirs: ["/accounts/review"], dispatchUnder: () => dispatch, alert: async () => undefined };
  return { reader: { read }, dispatch, accounts };
}

/** One shepherd-pr run under the visual seat's policy, reviewed MERGE with every check green, `visual` among them; only the file list varies. */
function visualRun(files: PrFile[], threshold?: VisualThreshold, blobs: Record<string, Uint8Array> = {}) {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("visual-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2), successRun("visual", 3)]);
  fake.prFiles.set(PR, files);
  fake.compares.set(`main...${HEAD}`, { mergeBaseSha: MERGE_BASE, files: [] });
  for (const [key, bytes] of Object.entries(blobs)) fake.bytes.set(key, bytes);
  let clock = T0;
  const store = shepherdStoreRef(() => clock);
  const tick = async (ms: number, signal: AbortSignal) => {
    clock += ms;
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const team = mergingReviewers(() => clock);
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, review: { ...team, timeoutMs: 5 * MINUTE, visualThreshold: () => threshold } });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(VISUAL) });
  store.get().register({ repo: REPO, pr: PR, runId, task: "demo/TP-1", implementer: "tc-synthetic", kind: "correctness", policy: VISUAL });
  const approveMerges = () => host.gates.listPending().filter((gate) => gate.id.startsWith(gateId(runId, "approve-merge")));
  const comments = () => (fake.comments.get(PR) ?? []).map((comment) => comment.body).join("\n");
  return { fake, approveMerges, comments, approveMerge: () => host.gates.get(gateId(runId, "approve-merge")) };
}

/** The base render at the merge base and the head render at the head, for one modified snapshot. */
const shotPair = (base: Uint8Array, head: Uint8Array) => ({ [`${MERGE_BASE}:${SNAPSHOT}`]: base, [`${HEAD}:${SNAPSHOT}`]: head });

describe("a glob-matched PR on a seat with visual baselines", () => {
  it("merges with no approve-merge gate when it changes no baseline and the visual check is green", async () => {
    const scene = visualRun([{ path: COMPONENT, status: "modified" }]);

    await vi.waitFor(() => expect(scene.approveMerge() !== undefined || scene.fake.effects.merge > 0).toBe(true), { timeout: 20_000 });

    expect(scene.approveMerge()?.prompt).toBeUndefined();
    await vi.waitFor(() => expect(scene.fake.effects.merge).toBe(1), { timeout: 20_000 });
    expect(scene.approveMerges()).toEqual([]);
  });

  it("records the clearance in the evidence comment, so it matches the merge", async () => {
    const scene = visualRun([{ path: COMPONENT, status: "modified" }]);

    await vi.waitFor(() => expect(scene.fake.effects.merge).toBe(1), { timeout: 20_000 });

    const bodies = (scene.fake.comments.get(PR) ?? []).map((comment) => comment.body).join("\n");
    expect(bodies).toContain(`visual files ${COMPONENT} changed no baseline and visual passed at ${HEAD}`);
  });

  it("opens one visual-path gate naming the baseline when the head also changes a baseline PNG", async () => {
    const scene = visualRun([{ path: COMPONENT, status: "modified" }, { path: BASELINE, status: "modified" }]);

    await vi.waitFor(() => expect(scene.approveMerge() !== undefined || scene.fake.effects.merge > 0).toBe(true), { timeout: 20_000 });

    const prompt = scene.approveMerge()!.prompt.split("\n")[0]!;
    expect(prompt).toContain(VISUAL_POLICY);
    expect(prompt.slice(prompt.indexOf(VISUAL_POLICY))).toContain(BASELINE);
    expect(scene.approveMerges()).toHaveLength(1);
    expect(scene.fake.effects.merge).toBe(0);
  });
});

/** TP-4320: under visualThreshold `on` the merge decides on the measured snapshot delta, not on whether a baseline changed. */
describe("a seat with visual baselines under visualThreshold on", () => {
  it("merges a snapshot change below the threshold with no approve-merge gate, and the comment shows the max share", async () => {
    const scene = visualRun([{ path: COMPONENT, status: "modified" }, { path: SNAPSHOT, status: "modified" }], THRESHOLD_ON, shotPair(card(false, 200), card(true, 200)));

    await vi.waitFor(() => expect(scene.fake.effects.merge).toBe(1), { timeout: 20_000 });

    expect(scene.approveMerges()).toEqual([]);
    expect(scene.comments()).toContain("changed 1 snapshot, max 0.3% (≤ 1.0%)");
    expect(scene.comments()).toContain(`| beat-card | \`${SNAPSHOT}\` | 0.3% | no |`);
  });

  it("opens one visual-path gate naming the component when a snapshot changes above the threshold", async () => {
    const scene = visualRun([{ path: SNAPSHOT, status: "modified" }], THRESHOLD_ON, shotPair(card(false, 200), card(true, 100)));

    await vi.waitFor(() => expect(scene.approveMerge()).toBeDefined(), { timeout: 20_000 });

    const prompt = scene.approveMerge()!.prompt;
    expect(prompt).toContain(VISUAL_POLICY);
    expect(prompt.slice(prompt.indexOf(VISUAL_POLICY))).toContain(`the owner decides visual changes: beat-card ${SNAPSHOT} changed 100.0% (over 1.0%)`);
    expect(scene.approveMerges()).toHaveLength(1);
    expect(scene.fake.effects.merge).toBe(0);
    expect(scene.comments()).toContain(`| beat-card | \`${SNAPSHOT}\` | 100.0% | yes |`);
  });

  it("opens one visual-path gate naming the API report when the public API changes", async () => {
    const scene = visualRun([{ path: COMPONENT, status: "modified" }, { path: API_REPORT, status: "modified" }], THRESHOLD_ON);

    await vi.waitFor(() => expect(scene.approveMerge()).toBeDefined(), { timeout: 20_000 });

    const prompt = scene.approveMerge()!.prompt;
    expect(prompt).toContain(VISUAL_POLICY);
    expect(prompt.slice(prompt.indexOf(VISUAL_POLICY))).toContain(`the owner decides visual changes: ${API_REPORT} (public API)`);
    expect(scene.approveMerges()).toHaveLength(1);
    expect(scene.fake.effects.merge).toBe(0);
    expect(scene.comments()).toContain(`Public API: \`${API_REPORT}\``);
  });
});

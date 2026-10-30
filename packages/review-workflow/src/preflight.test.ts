import { formatResultLine } from "@titan-design/fix-proof";
import type { PullRequest } from "@titan-design/github";
import { DEFAULT_PANEL_TABLE, type ReviewTarget } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import type { ReviewPlanPolicy } from "./plan-for-head.js";
import { preflight, type PreflightDecision } from "./preflight.js";
import { preflightRead, type PreflightPorts } from "./preflight-read.js";
import type { CarryProbe, CheckoutState, ProofRead } from "./ports.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SIGNED_OFF = "c".repeat(40);
const target: ReviewTarget = { repo: "acme/widgets", pr: 7, head: HEAD };

const POLICY: ReviewPlanPolicy = {
  panel: {
    roles: { g10: "bd-reviewer", standard: "reviewer" },
    shapeRoles: { adversary: { g10: "fable-reviewer", standard: "fable-reviewer" } },
    panel: DEFAULT_PANEL_TABLE,
  },
};

interface Fakes {
  pr?: Partial<PullRequest>;
  proof?: ProofRead;
  carry?: CarryProbe;
  checkout?: CheckoutState;
  uninstalled?: readonly string[];
}

function fakePorts(fakes: Fakes = {}): PreflightPorts {
  const pr: PullRequest = {
    number: target.pr,
    state: "open",
    merged: false,
    mergeSha: null,
    mergedAt: null,
    headRef: "feat/widgets",
    headSha: HEAD,
    headRepo: null,
    baseRef: "main",
    draft: false,
    mergeableState: "clean",
    behind: false,
    autoMerge: false,
    ...fakes.pr,
  };
  const changedFiles = [
    { path: "src/widget.ts", additions: 6, deletions: 2 },
    { path: "src/widget.test.ts", additions: 12, deletions: 0 },
  ];
  return {
    snapshot: { read: async () => ({ pr, ci: "green", facts: { ...target, base: BASE, changedFiles, authorityTouch: true } }) },
    proofReader: { read: async () => fakes.proof ?? { kind: "skipped" } },
    carry: { probe: async () => fakes.carry ?? { kind: "no-carry" } },
    checkout: { state: async () => fakes.checkout ?? { kind: "ready" }, refresh: async () => undefined },
    headroom: { read: async () => ({ opus: true, account: "available" }) },
    profiles: { installed: (profile) => !(fakes.uninstalled ?? []).includes(profile) },
  };
}

async function decide(fakes: Fakes = {}): Promise<PreflightDecision> {
  return preflight(await preflightRead({ target, policy: POLICY }, fakePorts(fakes)), POLICY);
}

const unprovenLine = formatResultLine({
  head: HEAD,
  mergeBase: BASE,
  verdict: "unproven",
  counts: { reproduces: 0, "passes-on-base": 0, "new-api": 1, "fails-on-head": 0, "not-run": 0 },
  notCollected: [],
  deletedTests: [],
  configEdited: false,
  tests: [{ file: "src/widget.test.ts", name: "renders", class: "new-api" }],
  truncated: false,
  base: "main",
});

describe("preflight", () => {
  it("refuses a plan whose adversary is lowered to an uninstalled profile before any dispatch (tp#1986)", async () => {
    const decision = await decide({ uninstalled: ["reviewer"] });

    expect(decision).toEqual({ kind: "fixer", fixerCase: { failure: "start-refused:profile", key: "profile", detail: ["reviewer"] } });
  });

  it("stops a clean merge-up of a head the review signed off as carried", async () => {
    const decision = await decide({ carry: { kind: "carries", from: SIGNED_OFF } });

    expect(decision).toEqual({ kind: "stop", outcome: { kind: "carried", head: HEAD, from: SIGNED_OFF } });
  });

  it("leaves a head that is behind its base to the author as needs-update", async () => {
    const decision = await decide({ pr: { mergeableState: "behind", behind: true } });

    expect(decision).toEqual({ kind: "stop", outcome: { kind: "needs-update", head: HEAD } });
  });

  it("leaves a dirty head to the author as a conflict", async () => {
    const decision = await decide({ pr: { mergeableState: "dirty" } });

    expect(decision).toEqual({ kind: "stop", outcome: { kind: "conflict", head: HEAD } });
  });

  it("stops a workflow-only head CI did not prove as a waivable NO_REPRO", async () => {
    const decision = await decide({ proof: { kind: "workflow-ci", proved: false, head: HEAD } });

    expect(decision).toEqual({ kind: "stop", outcome: { kind: "NO_REPRO", head: HEAD, waivable: true } });
  });

  it("asks to refresh a checkout at the wrong commit", async () => {
    const decision = await decide({ checkout: { kind: "wrong-commit", at: SIGNED_OFF } });

    expect(decision).toEqual({ kind: "heal", heals: ["refresh-checkout"] });
  });

  it("plans a blocking tests member for a head whose proof reads unproven", async () => {
    const decision = await decide({ proof: { kind: "result", line: unprovenLine } });

    expect(decision.kind === "go" && decision.plan.plan.members).toContainEqual(expect.objectContaining({ shape: "tests", blocking: true }));
  });
});

describe("preflightRead", () => {
  it("keeps the base the proof judged, for a later merge guard", async () => {
    const snapshot = await preflightRead({ target, policy: POLICY }, fakePorts({ proof: { kind: "result", line: unprovenLine } }));

    expect(snapshot.proofBase).toBe("main");
  });
});

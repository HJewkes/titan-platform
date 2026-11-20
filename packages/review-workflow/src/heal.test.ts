import type { PullRequest } from "@titan-design/github";
import type { PanelMember, ReviewTarget } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { applyHeal, type HealPorts } from "./heal.js";
import type { CheckoutState, HeadroomRead, HeadSnapshot } from "./ports.js";

const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const target: ReviewTarget = { repo: "acme/widgets", pr: 7, head: HEAD };

interface Fakes {
  ports: HealPorts;
  refreshes: () => number;
  checkoutState: () => CheckoutState;
}

function snapshotAt(headSha: string): HeadSnapshot {
  const pr: PullRequest = {
    number: target.pr,
    state: "open",
    merged: false,
    mergeSha: null,
    mergedAt: null,
    headRef: "feat/widgets",
    headSha,
    headRepo: null,
    baseRef: "main",
    draft: false,
    mergeableState: "clean",
    behind: false,
    autoMerge: false,
  };
  return { pr, ci: "green", facts: { ...target, head: headSha, base: "c".repeat(40), changedFiles: [] } };
}

function fakePorts(opts: { liveHead?: string; headroom?: HeadroomRead } = {}): Fakes {
  let state: CheckoutState = { kind: "wrong-commit", at: NEXT_HEAD };
  let refreshes = 0;
  const snapshot = snapshotAt(opts.liveHead ?? HEAD);
  const ports: HealPorts = {
    checkout: {
      state: async () => state,
      refresh: async () => {
        refreshes += 1;
        state = { kind: "ready" };
      },
    },
    snapshot: { read: async () => snapshot },
    headroom: { read: async () => opts.headroom ?? { opus: true, account: "available" } },
  };
  return { ports, refreshes: () => refreshes, checkoutState: () => state };
}

describe("applyHeal refresh-checkout", () => {
  it("refreshes the checkout once and hands back the same subject", async () => {
    const { ports, refreshes, checkoutState } = fakePorts();

    const effect = await applyHeal("refresh-checkout", { target }, ports);

    expect(effect).toEqual({ kind: "healed", subject: { target } });
    expect(refreshes()).toBe(1);
    expect(checkoutState()).toEqual({ kind: "ready" });
  });
});

describe("applyHeal retarget", () => {
  it("retargets a standalone run to the live head", async () => {
    const { ports } = fakePorts({ liveHead: NEXT_HEAD });

    const effect = await applyHeal("retarget", { target }, ports);

    expect(effect).toEqual({ kind: "healed", subject: { target: { ...target, head: NEXT_HEAD } } });
  });

  it("calls a retarget to the head already under review ineffective", async () => {
    const { ports } = fakePorts();

    const effect = await applyHeal("retarget", { target }, ports);

    expect(effect).toEqual({ kind: "ineffective", heal: "retarget" });
  });
});

describe("applyHeal degrade-headroom", () => {
  const premium: PanelMember = { shape: "correctness", profile: "bd-reviewer", briefId: "correctness", blocking: true, degraded: false };

  it("re-plans a refused premium member at its sonnet profile, marked degraded", async () => {
    const { ports } = fakePorts();

    const effect = await applyHeal("degrade-headroom", { target, member: premium }, ports);

    expect(effect).toEqual({ kind: "healed", subject: { target, member: { ...premium, profile: "reviewer", degraded: true } } });
  });

  it("calls a member with no sonnet fallback ineffective", async () => {
    const { ports } = fakePorts();
    const member = { ...premium, profile: "reviewer" };

    const effect = await applyHeal("degrade-headroom", { target, member }, ports);

    expect(effect).toEqual({ kind: "ineffective", heal: "degrade-headroom" });
  });

  it("does not degrade a member twice", async () => {
    const { ports } = fakePorts();
    const member = { ...premium, profile: "reviewer", degraded: true };

    const effect = await applyHeal("degrade-headroom", { target, member, sonnetFor: { reviewer: "cheap" } }, ports);

    expect(effect).toEqual({ kind: "ineffective", heal: "degrade-headroom" });
  });
});

describe("applyHeal await-account", () => {
  it("stops a held account as an account hold carrying its reset time", async () => {
    const { ports, refreshes } = fakePorts({ headroom: { opus: false, account: "held", resetsAt: 1_700_000_000_000 } });

    const effect = await applyHeal("await-account", { target }, ports);

    expect(effect).toEqual({ kind: "stop", outcome: { kind: "account-hold", head: HEAD, resetsAt: 1_700_000_000_000 } });
    expect(refreshes()).toBe(0);
  });

  it("passes the subject through when the account is available", async () => {
    const { ports } = fakePorts();

    const effect = await applyHeal("await-account", { target }, ports);

    expect(effect).toEqual({ kind: "healed", subject: { target } });
  });
});

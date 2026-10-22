import type { PullRequest } from "@titan-design/github";
import type { PanelMember, ReviewTarget } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { healOnce, type HealPorts, type HealRequest, type HealSubject } from "./heal.js";
import type { CheckoutState, HeadroomRead, HeadSnapshot } from "./ports.js";

const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const target: ReviewTarget = { repo: "acme/widgets", pr: 7, head: HEAD };

type Go = { kind: "go" };
const GO: Go = { kind: "go" };

interface Fakes {
  ports: HealPorts;
  refreshes: () => number;
}

function fakePorts(opts: { refreshFixes?: boolean; liveHead?: string; headroom?: HeadroomRead } = {}): Fakes {
  let state: CheckoutState = { kind: "wrong-commit", at: NEXT_HEAD };
  let refreshes = 0;
  const pr = { number: target.pr, headSha: opts.liveHead ?? HEAD } as PullRequest;
  const ports: HealPorts = {
    checkout: {
      state: async () => state,
      refresh: async () => {
        refreshes += 1;
        if (opts.refreshFixes ?? true) state = { kind: "ready" };
      },
    },
    snapshot: { read: async () => ({ pr, ci: "green", facts: {} as HeadSnapshot["facts"] }) },
    headroom: { read: async () => opts.headroom ?? { opus: true, account: "available" } },
  };
  return { ports, refreshes: () => refreshes };
}

const checkoutDecider =
  (ports: HealPorts) =>
  async (subject: HealSubject): Promise<Go | HealRequest> =>
    (await ports.checkout.state(subject.target)).kind === "ready" ? GO : { kind: "heal", heals: ["refresh-checkout"] };

const healRequest = (...heals: HealRequest["heals"]): HealRequest => ({ kind: "heal", heals });

describe("healOnce", () => {
  it("refreshes a checkout at the wrong commit once, and the re-decision passes", async () => {
    const { ports, refreshes } = fakePorts();

    const result = await healOnce<Go>(healRequest("refresh-checkout"), { target }, ports, checkoutDecider(ports));

    expect(result).toEqual({ kind: "decided", decision: GO, subject: { target } });
    expect(refreshes()).toBe(1);
  });

  it("sends a refresh that leaves the checkout wrong to the fixer instead of refreshing again", async () => {
    const { ports, refreshes } = fakePorts({ refreshFixes: false });

    const result = await healOnce<Go>(healRequest("refresh-checkout"), { target }, ports, checkoutDecider(ports));

    expect(result).toEqual({ kind: "fixer", key: "heal-ineffective", heals: ["refresh-checkout"] });
    expect(refreshes()).toBe(1);
  });

  it("passes a decision that asks for no heal through without touching a port", async () => {
    const { ports, refreshes } = fakePorts();

    const result = await healOnce<Go>(GO, { target }, ports, checkoutDecider(ports));

    expect(result).toEqual({ kind: "decided", decision: GO, subject: { target } });
    expect(refreshes()).toBe(0);
  });

  it("retargets a standalone run to the live head", async () => {
    const { ports } = fakePorts({ liveHead: NEXT_HEAD });

    const result = await healOnce<Go>(healRequest("retarget"), { target }, ports, async () => GO);

    expect(result).toMatchObject({ kind: "decided", subject: { target: { ...target, head: NEXT_HEAD } } });
  });

  it("calls a retarget to the head already under review ineffective", async () => {
    const { ports } = fakePorts();

    const result = await healOnce<Go>(healRequest("retarget"), { target }, ports, async () => GO);

    expect(result).toEqual({ kind: "fixer", key: "heal-ineffective", heals: ["retarget"] });
  });
});

describe("healOnce degrade-headroom", () => {
  const premium: PanelMember = { shape: "correctness", profile: "bd-reviewer", briefId: "correctness", blocking: true, degraded: false };

  it("re-plans a refused premium member at its sonnet profile, marked degraded", async () => {
    const { ports } = fakePorts();

    const result = await healOnce<Go>(healRequest("degrade-headroom"), { target, member: premium }, ports, async () => GO);

    expect(result).toMatchObject({ kind: "decided", subject: { member: { ...premium, profile: "reviewer", degraded: true } } });
  });

  it("sends a member with no sonnet fallback to the fixer", async () => {
    const { ports } = fakePorts();
    const member = { ...premium, profile: "reviewer" };

    const result = await healOnce<Go>(healRequest("degrade-headroom"), { target, member }, ports, async () => GO);

    expect(result).toEqual({ kind: "fixer", key: "heal-ineffective", heals: ["degrade-headroom"] });
  });

  it("does not degrade a member twice", async () => {
    const { ports } = fakePorts();
    const member = { ...premium, profile: "reviewer", degraded: true };

    const result = await healOnce<Go>(healRequest("degrade-headroom"), { target, member, sonnetFor: { reviewer: "cheap" } }, ports, async () => GO);

    expect(result).toMatchObject({ kind: "fixer", heals: ["degrade-headroom"] });
  });
});

describe("healOnce await-account", () => {
  it("stops a held account as an account hold, with no fixer and no further heal", async () => {
    const { ports, refreshes } = fakePorts({ headroom: { opus: false, account: "held", resetsAt: 1_700_000_000_000 } });

    const result = await healOnce<Go>(healRequest("await-account", "refresh-checkout"), { target }, ports, async () => GO);

    expect(result).toEqual({ kind: "stop", outcome: { kind: "account-hold", head: HEAD, resetsAt: 1_700_000_000_000 } });
    expect(refreshes()).toBe(0);
  });

  it("goes on to the re-decision when an account is available", async () => {
    const { ports } = fakePorts();

    const result = await healOnce<Go>(healRequest("await-account"), { target }, ports, async () => GO);

    expect(result).toEqual({ kind: "decided", decision: GO, subject: { target } });
  });
});

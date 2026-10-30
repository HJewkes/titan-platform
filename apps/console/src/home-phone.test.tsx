// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { RpcProvider } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import type { DataSource } from "@titan-design/rpc-client";
import { useInvalidate } from "./data/rpc.js";
import { NeedsYouRegion } from "./pages/HomeNeedsYou.js";
import { BELOW_MD } from "./pages/phone.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Synthetic inbox answers; nothing here comes from a real inbox.
const blocker = (id: string) => ({
  id, sources: [{ system: "hitl", ref: `run-${id}/approve-merge` }], kind: "approve", door: "one-way", summary: `Merge example/repo#${id}`, context: "", keys: [],
  personal: false, lens: "blocking-merge", unblocks: [], openedAt: "2031-03-05T10:00:00.000Z", status: "open", section: "blocking", action: { kind: "terminal", reason: "fixture" },
});
const inbox = (items: unknown[]) => ({ items, gaps: [], fyiCount: 0, readAt: "2031-03-05T12:00:00.000Z", derived: [] });

const QUIET: Record<string, unknown> = {
  "upstreams.health": { checkedAt: "2031-03-05T12:00:00.000Z", upstreams: [] },
  "agents.queue": { items: [], hidden: {}, open: 0, generatedAt: 0 },
  "work.tasks": { fetchedAt: "", evidence: { repos: [], degraded: [] }, tasks: [] },
};

/** Answers each inbox read with the next of `inboxes`, so a refetch can move the blocking count. */
function steppingSource(inboxes: unknown[][]): DataSource {
  let reads = 0;
  return {
    call: async (name) => successEnvelope(name === "inbox.list" ? inbox(inboxes[Math.min(reads++, inboxes.length - 1)]!) : QUIET[name]),
    subscribe: () => ({ close: () => undefined }),
  };
}

let refetchInbox = (): void => undefined;

function InboxRefetcher(): ReactNode {
  const invalidate = useInvalidate();
  refetchInbox = () => invalidate(["inbox.list"]);
  return null;
}

/** A phone viewport whose media-query listeners are counted, so one left behind by an unmounted hook shows. */
function onCountedPhone(): { live: () => number } {
  let added = 0;
  let removed = 0;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === BELOW_MD, media: query, addEventListener: () => void added++, removeEventListener: () => void removed++ }));
  return { live: () => added - removed };
}

describe("the home inbox card on a phone", () => {
  it("gives the inbox link a 44px tap target", async () => {
    onCountedPhone();
    render(
      <RpcProvider source={steppingSource([[blocker("1")]])}>
        <NeedsYouRegion />
      </RpcProvider>,
    );

    expect((await screen.findByText("Inbox: 1 blocking")).className).toContain("min-h-11");
  });

  it("holds one media listener as the blocking count drops to zero and comes back", async () => {
    const listeners = onCountedPhone();
    render(
      <RpcProvider source={steppingSource([[blocker("1")], [], [blocker("2")]])}>
        <InboxRefetcher />
        <NeedsYouRegion />
      </RpcProvider>,
    );
    await screen.findByText("Inbox: 1 blocking");

    act(() => refetchInbox());
    await waitFor(() => expect(screen.queryByTestId("home-inbox")).toBeNull());
    act(() => refetchInbox());
    await screen.findByText("Merge example/repo#2");

    expect(listeners.live()).toBe(1);
  });
});

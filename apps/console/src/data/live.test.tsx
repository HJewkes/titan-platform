// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { RpcProvider } from "@titan-design/react-app";
import type { DataSource, EventHandlers, LiveStatus } from "@titan-design/rpc-client";
import { useRelayInvalidation } from "./live.js";
import { useQuery } from "./rpc.js";

afterEach(cleanup);

const COALESCE_MS = 40;

const READS = ["work.portfolio", "agents.roster", "autoresearch.runs", "autoresearch.run", "blockers.banner"] as const;

/** A daemon stand-in that counts calls per command and lets the test push relayed frames and stream status. */
function countingSource(): { source: DataSource; calls: Map<string, number>; push(event: string, data?: object): void; status(next: LiveStatus): void } {
  const calls = new Map<string, number>();
  let handlers: EventHandlers | undefined;
  const source: DataSource = {
    call: async (name) => {
      calls.set(name, (calls.get(name) ?? 0) + 1);
      return { ok: true, data: {} };
    },
    subscribe: (next) => {
      handlers = next;
      queueMicrotask(() => next.onStatus?.("open"));
      return { close: () => undefined };
    },
  };
  return {
    source,
    calls,
    push: (event, data = { kind: "message" }) => handlers?.onEvent({ event, data: JSON.stringify(data) }),
    status: (next) => handlers?.onStatus?.(next),
  };
}

function Reads(): ReactNode {
  useRelayInvalidation(COALESCE_MS);
  useQuery("work.portfolio");
  useQuery("agents.roster");
  useQuery("autoresearch.runs");
  useQuery("autoresearch.run", { runId: "ar-0001" });
  useQuery("blockers.banner");
  return null;
}

async function renderReads(): Promise<ReturnType<typeof countingSource>> {
  const fake = countingSource();
  render(
    <RpcProvider source={fake.source}>
      <Reads />
    </RpcProvider>,
  );
  await waitFor(() => expect(counts(fake.calls)).toEqual([1, 1, 1, 1, 1]));
  return fake;
}

const counts = (calls: Map<string, number>): Array<number | undefined> => READS.map((name) => calls.get(name));

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("useRelayInvalidation", () => {
  it("coalesces a burst from one source into one refetch of only that source's reads", async () => {
    const { calls, push } = await renderReads();

    act(() => {
      for (let i = 0; i < 25; i++) push("agent-chat");
    });
    await waitFor(() => expect(calls.get("agents.roster")).toBe(2));
    await pause(COALESCE_MS * 3);

    expect(counts(calls)).toEqual([1, 2, 1, 1, 1]);
  });

  it("coalesces a burst of factory frames into one refetch of only the autoresearch and blocker reads", async () => {
    const { calls, push } = await renderReads();

    act(() => {
      for (let i = 0; i < 25; i++) push("factory");
    });
    await waitFor(() => expect(calls.get("autoresearch.run")).toBe(2));
    await pause(COALESCE_MS * 3);

    expect(counts(calls)).toEqual([1, 1, 2, 2, 2]);
  });

  it("a shepherd frame no longer refetches autoresearch reads", async () => {
    const { calls, push } = await renderReads();

    act(() => push("factory", { kind: "shepherd", workflow: "shepherd", runId: "r1" }));
    await waitFor(() => expect(calls.get("blockers.banner")).toBe(2));
    await pause(COALESCE_MS * 3);

    expect(counts(calls)).toEqual([1, 1, 1, 1, 2]);
  });

  it("an autoresearch frame refetches autoresearch reads", async () => {
    const { calls, push } = await renderReads();

    act(() => push("factory", { kind: "shepherd", workflow: "autoresearch", runId: "ar-0001" }));
    await waitFor(() => expect(calls.get("autoresearch.run")).toBe(2));
    await pause(COALESCE_MS * 3);

    expect(counts(calls)).toEqual([1, 1, 2, 2, 2]);
  });

  it("a frame without a kind keeps the old invalidation", async () => {
    const { calls, push } = await renderReads();

    act(() => push("factory", { kind: "shepherd", runId: "r1" }));
    await waitFor(() => expect(calls.get("autoresearch.run")).toBe(2));
    await pause(COALESCE_MS * 3);

    expect(counts(calls)).toEqual([1, 1, 2, 2, 2]);
  });

  it("an autoresearch frame in the same window as a shepherd one still refetches autoresearch reads", async () => {
    const { calls, push } = await renderReads();

    act(() => {
      push("factory", { kind: "shepherd", workflow: "shepherd" });
      push("factory", { kind: "shepherd", workflow: "autoresearch" });
    });
    await waitFor(() => expect(calls.get("autoresearch.run")).toBe(2));

    expect(counts(calls)).toEqual([1, 1, 2, 2, 2]);
  });

  it("refetches once per window under a steady stream instead of waiting for it to stop", async () => {
    const { calls, push } = await renderReads();

    const startedAt = Date.now();
    while (Date.now() - startedAt < COALESCE_MS * 4) {
      act(() => push("active-work"));
      await pause(4);
    }
    await pause(COALESCE_MS * 2);

    const refetches = (calls.get("work.portfolio") ?? 0) - 1;
    expect(refetches).toBeGreaterThanOrEqual(2);
    expect(refetches).toBeLessThanOrEqual(6);
    expect(calls.get("agents.roster")).toBe(1);
  });

  it("refetches every relayed read once the browser's stream reopens", async () => {
    const { calls, status } = await renderReads();

    act(() => status("connecting"));
    act(() => status("open"));

    await waitFor(() => expect(counts(calls)).toEqual([2, 2, 2, 2, 2]));
  });
});

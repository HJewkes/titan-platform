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

/** A daemon stand-in that counts calls per command and lets the test push relayed frames and stream status. */
function countingSource(): { source: DataSource; calls: Map<string, number>; push(event: string): void; status(next: LiveStatus): void } {
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
    push: (event) => handlers?.onEvent({ event, data: JSON.stringify({ kind: "message" }) }),
    status: (next) => handlers?.onStatus?.(next),
  };
}

function Reads(): ReactNode {
  useRelayInvalidation(COALESCE_MS);
  useQuery("work.portfolio");
  useQuery("agents.roster");
  return null;
}

async function renderReads(): Promise<ReturnType<typeof countingSource>> {
  const fake = countingSource();
  render(
    <RpcProvider source={fake.source}>
      <Reads />
    </RpcProvider>,
  );
  await waitFor(() => expect([fake.calls.get("work.portfolio"), fake.calls.get("agents.roster")]).toEqual([1, 1]));
  return fake;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("useRelayInvalidation", () => {
  it("coalesces a burst from one source into one refetch of only that source's reads", async () => {
    const { calls, push } = await renderReads();

    act(() => {
      for (let i = 0; i < 25; i++) push("agent-chat");
    });
    await waitFor(() => expect(calls.get("agents.roster")).toBe(2));
    await pause(COALESCE_MS * 3);

    expect([calls.get("work.portfolio"), calls.get("agents.roster")]).toEqual([1, 2]);
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

    await waitFor(() => expect([calls.get("work.portfolio"), calls.get("agents.roster")]).toEqual([2, 2]));
  });
});

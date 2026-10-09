// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { RpcProvider } from "@titan-design/react-app";
import type { DataSource, EventHandlers } from "@titan-design/rpc-client";
import { useRelayInvalidation } from "./live.js";
import { useQuery } from "./rpc.js";

afterEach(cleanup);

/** A daemon stand-in that counts calls per command and lets the test push relayed frames. */
function countingSource(): { source: DataSource; calls: Map<string, number>; push(event: string): void } {
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
  return { source, calls, push: (event) => handlers?.onEvent({ event, data: JSON.stringify({ kind: "message" }) }) };
}

function Reads(): ReactNode {
  useRelayInvalidation();
  useQuery("work.portfolio");
  useQuery("agents.roster");
  return null;
}

describe("useRelayInvalidation", () => {
  it("refetches only the reads of the upstream a relayed event came from", async () => {
    const { source, calls, push } = countingSource();
    render(
      <RpcProvider source={source}>
        <Reads />
      </RpcProvider>,
    );
    await waitFor(() => expect([calls.get("work.portfolio"), calls.get("agents.roster")]).toEqual([1, 1]));

    act(() => push("agent-chat"));
    await waitFor(() => expect(calls.get("agents.roster")).toBe(2));
    act(() => push("active-work"));
    await waitFor(() => expect(calls.get("work.portfolio")).toBe(2));

    expect([calls.get("work.portfolio"), calls.get("agents.roster")]).toEqual([2, 2]);
  });
});

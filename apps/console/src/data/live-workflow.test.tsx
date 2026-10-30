// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { RpcProvider } from "@titan-design/react-app";
import type { DataSource, EventHandlers } from "@titan-design/rpc-client";
import { useRelayInvalidation } from "./live.js";
import { useQuery } from "./rpc.js";

afterEach(cleanup);

const COALESCE_MS = 40;
const READS = ["autoresearch.runs", "autoresearch.run", "blockers.banner"] as const;

function countingSource(): { source: DataSource; calls: Map<string, number>; push(data: object): void } {
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
  return { source, calls, push: (data) => handlers?.onEvent({ event: "factory", data: JSON.stringify(data) }) };
}

function Reads(): ReactNode {
  useRelayInvalidation(COALESCE_MS);
  useQuery("autoresearch.runs");
  useQuery("autoresearch.run", { runId: "ar-0001" });
  useQuery("blockers.banner");
  return null;
}

const counts = (calls: Map<string, number>): Array<number | undefined> => READS.map((name) => calls.get(name));
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function renderReads(): Promise<ReturnType<typeof countingSource>> {
  const fake = countingSource();
  render(
    <RpcProvider source={fake.source}>
      <Reads />
    </RpcProvider>,
  );
  await waitFor(() => expect(counts(fake.calls)).toEqual([1, 1, 1]));
  return fake;
}

describe("useRelayInvalidation by frame workflow", () => {
  it("a shepherd frame no longer refetches autoresearch reads", async () => {
    const { calls, push } = await renderReads();

    act(() => push({ kind: "shepherd", workflow: "shepherd", runId: "r1" }));
    await waitFor(() => expect(calls.get("blockers.banner")).toBe(2));
    await pause(COALESCE_MS * 3);

    expect(counts(calls)).toEqual([1, 1, 2]);
  });

  it("an autoresearch frame refetches autoresearch reads", async () => {
    const { calls, push } = await renderReads();

    act(() => push({ kind: "shepherd", workflow: "autoresearch", runId: "ar-0001" }));
    await waitFor(() => expect(calls.get("autoresearch.run")).toBe(2));
    await pause(COALESCE_MS * 3);

    expect(counts(calls)).toEqual([2, 2, 2]);
  });

  it("a frame without a kind keeps the old invalidation", async () => {
    const { calls, push } = await renderReads();

    act(() => push({ kind: "shepherd", runId: "r1" }));
    await waitFor(() => expect(calls.get("autoresearch.run")).toBe(2));
    await pause(COALESCE_MS * 3);

    expect(counts(calls)).toEqual([2, 2, 2]);
  });

  it("an autoresearch frame in the same window as a shepherd one still refetches autoresearch reads", async () => {
    const { calls, push } = await renderReads();

    act(() => {
      push({ kind: "shepherd", workflow: "shepherd" });
      push({ kind: "shepherd", workflow: "autoresearch" });
    });
    await waitFor(() => expect(calls.get("autoresearch.run")).toBe(2));

    expect(counts(calls)).toEqual([2, 2, 2]);
  });
});

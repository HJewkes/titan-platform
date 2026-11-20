import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listAgentLineage, listAgents, retire } from "./agents.js";
import { DispatchError } from "./dispatch.js";
import { messageAgent } from "./message.js";
import { parkAgent } from "./park.js";
import { installExecutable } from "./test-support.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-dispatch-abort-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sleepingBin(): string {
  const path = join(dir, "agent-chat");
  installExecutable(path, "#!/bin/sh\nsleep 30\n");
  return path;
}

type Call = (bin: string, signal: AbortSignal) => Promise<unknown>;

const calls: Record<string, Call> = {
  listAgents: (bin, signal) => listAgents(bin, 60_000, {}, signal),
  listAgentLineage: (bin, signal) => listAgentLineage(bin, 60_000, signal),
  retire: (bin, signal) => retire(bin, "item-42", 60_000, {}, signal),
  messageAgent: (bin, signal) => messageAgent(bin, "impl-a", "hello", 60_000, {}, signal),
  parkAgent: (bin, signal) => parkAgent(bin, "impl-a", 60_000, {}, signal),
};

describe.each(Object.entries(calls))("%s with an AbortSignal", (_name, call) => {
  it("rejects with DispatchError when aborted mid-call", async () => {
    const controller = new AbortController();
    const running = call(sleepingBin(), controller.signal);
    setTimeout(() => controller.abort(), 100);

    await expect(running).rejects.toBeInstanceOf(DispatchError);
  });

  it("starts no child when the signal is already aborted", async () => {
    await expect(call(sleepingBin(), AbortSignal.abort())).rejects.toBeInstanceOf(DispatchError);
  });
});

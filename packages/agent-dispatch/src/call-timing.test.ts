import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listAgents, retire } from "./agents.js";
import { agentChatVerb, observeAgentChatCalls, type AgentChatCall } from "./call-timing.js";
import { DispatchError, DispatchTimeoutError, dispatchToAgentChat } from "./dispatch.js";
import { installExecutable, installProfiles } from "./test-support.js";

const PROFILE = "relay-implementer";

let dir: string;
let calls: AgentChatCall[];
let unobserve: () => void;

/** Each read advances 7 s, so one call measures exactly 7000 ms. */
function steppingClock(stepMs = 7_000): () => number {
  let t = 0;
  return () => (t += stepMs);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-dispatch-timing-"));
  calls = [];
  unobserve = observeAgentChatCalls((call) => calls.push(call), { now: steppingClock() });
});

afterEach(() => {
  unobserve();
  rmSync(dir, { recursive: true, force: true });
});

function fakeAgentChat(script: string): string {
  const path = join(dir, "agent-chat");
  installExecutable(path, `#!/bin/sh\ncat >/dev/null\n${script}`);
  return path;
}

const spawnRequest = (bin: string) => ({
  agentChatBinPath: bin,
  peerName: "relay-item-42",
  profile: PROFILE,
  brief: "Fix the squeaky floor",
  briefing: "relay-secret-briefing",
  cwd: dir,
  profilesDir: installProfiles(dir, { [PROFILE]: "headless" }),
});

describe("agent-chat call timing", () => {
  it("reports a roster read once as agent ls with the injected clock's duration", async () => {
    await listAgents(fakeAgentChat("echo '[]'\n"), 10_000);

    expect(calls).toEqual([{ verb: "agent ls", ms: 7000, outcome: "ok" }]);
  });

  it("reports a spawn as agent spawn with no peer name or briefing in any field", async () => {
    await dispatchToAgentChat(spawnRequest(fakeAgentChat("exit 0\n")), 10_000, [PROFILE]);

    expect(calls).toEqual([{ verb: "agent spawn", ms: 7000, outcome: "ok" }]);
    const fields = JSON.stringify(calls);
    expect(fields).not.toContain("relay-item-42");
    expect(fields).not.toContain("relay-secret-briefing");
  });

  it("reports a timeout and still rejects with DispatchTimeoutError", async () => {
    const bin = fakeAgentChat("exec sleep 5\n");

    await expect(listAgents(bin, 200)).rejects.toThrow(DispatchTimeoutError);

    expect(calls).toEqual([{ verb: "agent ls", ms: 7000, outcome: "timeout" }]);
  });

  it("reports a spawn timeout from the raw exec error", async () => {
    const bin = fakeAgentChat("exec sleep 5\n");

    await expect(dispatchToAgentChat(spawnRequest(bin), 200, [PROFILE])).rejects.toThrow(
      DispatchTimeoutError,
    );

    expect(calls.map((c) => c.outcome)).toEqual(["timeout"]);
  });

  it("reports a non-zero exit as refused and retire still throws DispatchError", async () => {
    const bin = fakeAgentChat("echo 'no such agent'\nexit 1\n");

    await expect(retire(bin, "item-42", 10_000)).rejects.toThrow(DispatchError);

    expect(calls).toEqual([{ verb: "agent retire", ms: 7000, outcome: "refused" }]);
  });

  it("reports a missing binary as error and rethrows the original failure", async () => {
    await expect(listAgents(join(dir, "missing"), 10_000)).rejects.toThrow(DispatchError);

    expect(calls.map((c) => c.outcome)).toEqual(["error"]);
  });

  it("ignores an observer that throws", async () => {
    const stopThrowing = observeAgentChatCalls(() => {
      throw new Error("observer broke");
    });

    try {
      await expect(listAgents(fakeAgentChat("echo '[]'\n"), 10_000)).resolves.toEqual([]);
    } finally {
      stopThrowing();
    }
    expect(calls).toHaveLength(1);
  });

  it("reports nothing after unobserve", async () => {
    unobserve();

    await listAgents(fakeAgentChat("echo '[]'\n"), 10_000);

    expect(calls).toEqual([]);
  });
});

describe("agentChatVerb", () => {
  it("names agent verbs by their first two words and never a third", () => {
    expect(agentChatVerb(["agent", "ls", "--json"])).toBe("agent ls");
    expect(agentChatVerb(["agent", "spawn", "relay-item-42", "--briefing", "x"])).toBe("agent spawn");
  });

  it("names other verbs by their first word", () => {
    expect(agentChatVerb(["ask", "--label", "x"])).toBe("ask");
  });

  it("names an empty argv unknown", () => {
    expect(agentChatVerb([])).toBe("unknown");
  });
});

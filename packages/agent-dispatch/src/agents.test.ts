import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DispatchTimeoutError,
  listAgents,
  retire,
} from "./agents.js";
import { DispatchError } from "./dispatch.js";
import { installExecutable } from "./test-support.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-dispatch-agents-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `agent-chat` that records its argv NUL-separated, then runs `script`. */
function fakeAgentChat(script: string): string {
  const path = join(dir, "agent-chat");
  installExecutable(
    path,
    `#!/bin/sh\n` +
      `: >"${dir}/argv"\n` +
      `for a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\n` +
      script,
  );
  return path;
}

const recordedArgv = (): string[] =>
  readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);

function printing(json: unknown): string {
  const file = join(dir, "roster.json");
  writeFileSync(file, JSON.stringify(json, null, 2));
  return fakeAgentChat(`cat "${file}"\n`);
}

const row = (over: Record<string, unknown> = {}) => ({
  name: "item-42",
  agentId: "9e3faa6c",
  state: "exited",
  presence: "exited",
  status: "finished",
  profile: "headless-implementer",
  surface: "headless",
  model: "claude-opus-5-5",
  cwd: "/work/tree",
  sessionId: "7ce7e968-2f3b-4d7d-a7bf-2bf95a5c0c65",
  transcriptPath: "/sessions/7ce7e968-2f3b-4d7d-a7bf-2bf95a5c0c65.jsonl",
  transcriptExists: true,
  spawnedBy: "coordinator",
  account: null,
  generation: 1,
  teleportFrom: null,
  ...over,
});

describe("listAgents", () => {
  it("asks for the JSON roster and returns every row agent-chat printed", async () => {
    const rows = [row(), row({ name: "item-7", status: "running", presence: "live" })];
    const bin = printing(rows);

    expect(await listAgents(bin, 10_000)).toEqual(rows);
    expect(recordedArgv()).toEqual(["agent", "ls", "--json"]);
  });

  it("skips a row missing a field it relies on, rather than guessing its status", async () => {
    const bin = printing([row(), { name: "half-a-row", agentId: "x" }, null]);
    expect((await listAgents(bin, 10_000)).map((agent) => agent.name)).toEqual(["item-42"]);
  });

  it("refuses output that is not a JSON array, such as an agent-chat without --json", async () => {
    const bin = fakeAgentChat(`echo "item-42  finished  implementer  9e3faa6c"\n`);
    await expect(listAgents(bin, 10_000)).rejects.toThrow(/invalid JSON/);
    await expect(listAgents(printing({ agents: [] }), 10_000)).rejects.toThrow(/not print an array/);
  });

  it("reports an unknown --json option from stderr, not as a bare exit code", async () => {
    const bin = fakeAgentChat(`echo "error: unknown option '--json'" >&2\nexit 1\n`);
    await expect(listAgents(bin, 10_000)).rejects.toThrow(/unknown option '--json'/);
  });

  it("marks a hung CLI as a timeout, apart from a CLI that refused", async () => {
    await expect(listAgents(fakeAgentChat("sleep 3\n"), 200)).rejects.toThrow(DispatchTimeoutError);
    const refused = await listAgents(fakeAgentChat("exit 1\n"), 10_000).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DispatchError);
    expect(refused).not.toBeInstanceOf(DispatchTimeoutError);
  });

  it("keeps the event loop free while a slow roster read is in flight", async () => {
    const bin = fakeAgentChat(`sleep 1\ncat "${join(dir, "roster.json")}"\n`);
    writeFileSync(join(dir, "roster.json"), JSON.stringify([row()]));
    const order: string[] = [];
    const ticker = setTimeout(() => order.push("tick"), 50);

    const read = listAgents(bin, 10_000).then(() => order.push("roster"));
    await read;
    clearTimeout(ticker);

    expect(order).toEqual(["tick", "roster"]);
  });
});

describe("retire", () => {
  it("retires by name and returns the broker's caveats verbatim", () => {
    const bin = fakeAgentChat(
      `echo "Retired item-42."\necho "the process had already exited"\n`,
    );

    const result = retire(bin, "item-42", 10_000);

    expect(result).toEqual({ name: "item-42", caveats: ["the process had already exited"] });
    expect(recordedArgv()).toEqual(["agent", "retire", "item-42"]);
  });

  it("passes --force only when asked", () => {
    const bin = fakeAgentChat(`echo "Retired item-42."\n`);
    retire(bin, "item-42", 10_000, { force: true });
    expect(recordedArgv()).toEqual(["agent", "retire", "item-42", "--force"]);
  });

  it("reports the broker's refusal verbatim", () => {
    const bin = fakeAgentChat(
      `echo "Not retired: the worktree holds uncommitted work; pass --force"\nexit 1\n`,
    );
    expect(() => retire(bin, "item-42", 10_000)).toThrow(/holds uncommitted work/);
  });

  it("refuses a name that could read as a flag before running anything", () => {
    const bin = fakeAgentChat("exit 0\n");
    expect(() => retire(bin, "--force", 10_000)).toThrow(DispatchError);
    expect(() => readFileSync(join(dir, "argv"))).toThrow();
  });

  it("refuses a binary path that is not absolute", () => {
    expect(() => retire("agent-chat", "item-42", 10_000)).toThrow(DispatchError);
  });
});

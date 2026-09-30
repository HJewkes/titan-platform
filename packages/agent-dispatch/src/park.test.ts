import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrokerUnavailableError, DispatchError } from "./dispatch.js";
import { parkAgent } from "./park.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-dispatch-park-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `agent-chat` that records its argv NUL-separated, then runs `script`. */
function fakeAgentChat(script: string): string {
  const path = join(dir, "agent-chat");
  writeFileSync(
    path,
    `#!/bin/sh\n: >"${dir}/argv"\nfor a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\n${script}`,
  );
  chmodSync(path, 0o755);
  return path;
}

const recordedArgv = (): string[] => readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);

describe("parkAgent", () => {
  it("runs agent park by name and returns the broker's report lines", () => {
    const bin = fakeAgentChat(`echo "Parked impl-a."\necho "Bring it back with: agent-chat agent resume impl-a"\n`);

    const parked = parkAgent(bin, "impl-a", 10_000);

    expect(recordedArgv()).toEqual(["agent", "park", "impl-a"]);
    expect(parked).toEqual({ name: "impl-a", lines: ["Parked impl-a.", "Bring it back with: agent-chat agent resume impl-a"] });
  });

  it("throws the broker's refusal reason when the tree is not parkable", () => {
    const bin = fakeAgentChat(`echo "Not parked: impl-a's worktree has uncommitted changes"\nexit 1\n`);

    expect(() => parkAgent(bin, "impl-a", 10_000)).toThrow(/refused agent park: Not parked: impl-a's worktree has uncommitted changes/);
  });

  it("throws BrokerUnavailableError when the CLI cannot reach the broker", () => {
    const bin = fakeAgentChat(`echo "could not reach or start the agent-chat broker" >&2\nexit 1\n`);

    expect(() => parkAgent(bin, "impl-a", 10_000)).toThrow(BrokerUnavailableError);
  });

  it("refuses a name outside agent-chat's shape before running anything", () => {
    const bin = fakeAgentChat("exit 0\n");

    expect(() => parkAgent(bin, "--force", 10_000)).toThrow(DispatchError);
    expect(() => readFileSync(join(dir, "argv"))).toThrow();
  });
});

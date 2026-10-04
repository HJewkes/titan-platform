import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrokerUnavailableError, DispatchError } from "./dispatch.js";
import { messageAgent } from "./message.js";
import { installExecutable } from "./test-support.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-dispatch-message-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `agent-chat` that records its argv NUL-separated, then runs `script`. */
function fakeAgentChat(script: string): string {
  const path = join(dir, "agent-chat");
  installExecutable(
    path,
    `#!/bin/sh\n: >"${dir}/argv"\nfor a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\n${script}`,
  );
  return path;
}

const recordedArgv = (): string[] => readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);

describe("messageAgent", () => {
  it("sends the whole text as one operand after --, so a leading dash is not an option", () => {
    const bin = fakeAgentChat(`echo "Delivered to impl-a (msg_id m1)."\n`);

    messageAgent(bin, "impl-a", "--fix the parser\nthen push", 10_000);

    expect(recordedArgv()).toEqual(["debug", "send", "--", "impl-a", "--fix the parser\nthen push"]);
  });

  it("throws the broker's reason when no live session holds the name", () => {
    const bin = fakeAgentChat(`echo 'Not delivered: no active session named "impl-a"'\nexit 1\n`);

    expect(() => messageAgent(bin, "impl-a", "wake up", 10_000)).toThrow(/refused send: Not delivered: no active session named "impl-a"/);
  });

  it("throws BrokerUnavailableError when the CLI cannot reach the broker", () => {
    const bin = fakeAgentChat(`echo "could not reach or start the agent-chat broker" >&2\nexit 1\n`);

    expect(() => messageAgent(bin, "impl-a", "wake up", 10_000)).toThrow(BrokerUnavailableError);
  });

  it("refuses a bad name or empty text before running anything", () => {
    const bin = fakeAgentChat("exit 0\n");

    expect(() => messageAgent(bin, "--force", "wake up", 10_000)).toThrow(DispatchError);
    expect(() => messageAgent(bin, "impl-a", "  ", 10_000)).toThrow(DispatchError);
    expect(() => readFileSync(join(dir, "argv"))).toThrow();
  });
});

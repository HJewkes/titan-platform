import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seatNotifier } from "./round-notice-transport.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "console-round-notice-transport-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `agent-chat` that records its argv NUL-separated and reports delivery. */
function fakeAgentChat(): string {
  const path = join(dir, "agent-chat");
  writeFileSync(
    path,
    `#!/bin/sh\n: >"${dir}/argv"\nfor a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\necho "Delivered to alpha (msg_id m1)."\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const recordedArgv = (): string[] => readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);

describe("seatNotifier", () => {
  it("sends a notice labelled with the console source, not as the owner typing", async () => {
    const notify = seatNotifier(fakeAgentChat());

    await notify("alpha", "round r-test answered");

    expect(recordedArgv()).toEqual(["debug", "send", "--source", "console", "--", "alpha", "round r-test answered"]);
  });
});

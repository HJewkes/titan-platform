import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";
import { countWork } from "../test-support/work-count.js";
import { MAX_NESTING } from "./nesting.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};
const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };

const event = (command: string) =>
  JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });

/** A stored value nesting `$(` inside `[` over and over, then evaluated by `let`. */
const nestedValue = (repeats: number) =>
  `a='x[${'$("'.repeat(repeats)}[1${')"'.repeat(repeats)}]'; let a\n${PUSH}`;

/** At most 343 characters read a character (60 nested); walking the value again per nesting level would be quadratic in it. */
const WORK_PER_CHAR = 600;
const EVENT_WORK = 10_000;

async function counted(command: string) {
  let stdout = "";
  await countWork(async () => ({ stdout } = await handle(event(command), { PATH: "/usr/bin" }, port)), EVENT_WORK + command.length * WORK_PER_CHAR);
  return { stdout };
}

describe("a nested subscript value is walked in bounded time (TP-2243)", () => {
  it.each([30, 40, 60, 200, 2000])("denies %i nested substitutions inside brackets within its work budget", async (repeats) => {
    const { stdout } = await counted(nestedValue(repeats));
    expect(stdout).toContain('"permissionDecision":"deny"');
  });

  it("denies a value nested past the limit rather than allowing it", async () => {
    const { stdout } = await counted(nestedValue(MAX_NESTING + 50));
    expect(stdout).toContain('"permissionDecision":"deny"');
  });
});

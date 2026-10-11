import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";
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

async function timed(command: string) {
  const start = performance.now();
  const result = await handle(event(command), { PATH: "/usr/bin" }, port);
  return { stdout: result.stdout, ms: performance.now() - start };
}

describe("a nested subscript value is walked in bounded time (TP-2243)", () => {
  it.each([30, 40, 60, 200, 2000])("denies %i nested substitutions inside brackets in under a second", async (repeats) => {
    const { stdout, ms } = await timed(nestedValue(repeats));
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(ms).toBeLessThan(1000);
  });

  it("denies a value nested past the limit rather than allowing it", async () => {
    const { stdout } = await timed(nestedValue(MAX_NESTING + 50));
    expect(stdout).toContain('"permissionDecision":"deny"');
  });
});

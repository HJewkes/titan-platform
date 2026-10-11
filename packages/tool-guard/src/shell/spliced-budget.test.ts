import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { extractCommands } from "./commands.js";
import { SplicedReadingError } from "./unsure-readings.js";

const HOME = "/home/you";
const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};
const port: HookPort = { context: nodeContext(HOME, noFs), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

const PUSH = "git push origin HEAD:main";
const SPLICED_REASON = "read again with what their substitutions print";

/** Text quoted for the inside of a double-quoted word. */
const quoted = (text: string) => text.replace(/[\\"$`]/g, (c) => `\\${c}`);

/** `inner` under `depth` evals whose text starts with a substitution, so the spliced and plain readings both hold the next eval. */
const nested = (inner: string, depth: number): string => (depth === 0 ? inner : `eval "$(echo :);${quoted(nested(inner, depth - 1))}"`);

function bash(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
}

describe("the budget for text that splicing a substitution's output adds", () => {
  it("refuses an 8 KiB line of eight nested evals in well under a second, not after 2^8 walks", async () => {
    const line = nested(`${"echo hi;".repeat(900)}${PUSH}`, 8);
    const started = performance.now();

    const result = await handle(bash(line), {}, port);

    expect(line.length).toBeLessThan(8 * 1024);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    expect(result.stdout).toContain(SPLICED_REASON);
  });

  it("throws rather than reading a line past the budget as if it had no spliced readings", () => {
    const line = nested(PUSH, 8);

    expect(() => extractCommands(line)).toThrow(SplicedReadingError);
    expect(() => extractCommands(line, { stopPastCap: true })).toThrow(SplicedReadingError);
  });

  it("denies a benign line past the budget too, since what it would run is unchecked", async () => {
    const result = await handle(bash(nested("echo ok", 6)), {}, port);

    expect(result.stdout).toContain(SPLICED_REASON);
  });

  it("still reads a push through two nested evals within the budget", async () => {
    const line = nested(PUSH, 2);

    const pushes = extractCommands(line).filter((cmd) => cmd.name === "git");
    const result = await handle(bash(line), {}, port);

    expect(pushes.length).toBeGreaterThan(0);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    expect(result.stdout).not.toContain(SPLICED_REASON);
  });

  it("passes a benign line of two nested evals", async () => {
    const result = await handle(bash(nested("echo ok", 2)), {}, port);

    expect(result.stdout).toBe("");
  });
});

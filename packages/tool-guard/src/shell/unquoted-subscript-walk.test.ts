import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";
const MARKER = "MARKER-RAN";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};
const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };

const event = (command: string) =>
  JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });

/** The value-walk-bound probe without its single quotes, as tc-tp-2243-guard-walk-bound ran it (tp#1005). */
const unquoted = (repeats: number, tail = PUSH) => `a=x[${'$("'.repeat(repeats)}[1${')"'.repeat(repeats)}]; let a\n${tail}`;
const quoted = (repeats: number) => `a='x[${'$("'.repeat(repeats)}[1${')"'.repeat(repeats)}]'; let a\n${PUSH}`;

const decisionOf = (stdout: string) => (stdout ? (JSON.parse(stdout).hookSpecificOutput?.permissionDecision ?? null) : null);

describe("an unquoted nested-subscript assignment before a push (TP-2248)", () => {
  it.each([6, 9, 12])("denies the unquoted form at %i nested substitutions as unparsed", async (repeats) => {
    const result = await handle(event(unquoted(repeats)), { PATH: "/usr/bin" }, port);

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "unparsed", "bash.unparsed"]);
  });

  it.each([6, 9, 12])("denies the single-quoted form at %i nested substitutions", async (repeats) => {
    const result = await handle(event(quoted(repeats)), { PATH: "/usr/bin" }, port);

    expect(decisionOf(result.stdout)).toBe("deny");
  });
});

const bashOnPath = spawnSync("bash", ["-c", "true"]).status === 0;

// Bash reads each `"` after `$(` as opening a string the `)"` pairs never close, so the push is never reached.
describe.skipIf(!bashOnPath)("bash on the unquoted form", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tool-guard-tp-2248-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const bash = (...args: string[]) => spawnSync("bash", args, { cwd: scratch, encoding: "utf-8", timeout: 5000 });

  it.each([6, 9, 12])("rejects the text at %i nested substitutions with an unterminated quote", (repeats) => {
    const run = bash("-n", "-c", unquoted(repeats, `echo ${MARKER}`));

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("unexpected EOF");
  });

  it.each([6, 9, 12])("never runs the line after it at %i nested substitutions", (repeats) => {
    const run = bash("-c", unquoted(repeats, `echo ${MARKER}`));

    expect(run.status).not.toBe(0);
    expect(run.stdout).not.toContain(MARKER);
  });
});

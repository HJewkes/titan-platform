import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";
import { tokenize } from "./lexer.js";
import { MAX_NESTING } from "./nesting.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};

function event(command: string, cwd = REPO): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd, tool_input: { command } });
}

// The built bundle runs cold in a fresh process, as the hook does; CI builds before it tests, locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-nesting-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const nest = (open: string, inner: string, close: string, depth: number) => open.repeat(depth) + inner + close.repeat(depth);

/** Each nests past the stack of a recursive reader; bash 5.3 runs the line after it. */
const DEEP: Array<[string, string]> = [
  ["$(( nested 1100 deep", `echo ${nest("$((", "1", "))", 1100)}`],
  ["${ nested 2700 deep", `: ${nest("${", "", "}", 2700)}`],
  ["$( nested 2000 deep", `echo ${nest("$(", "echo 1", ")", 2000)}`],
];

describe("expansions nested past the reading limit", () => {
  it.each(DEEP)("the hook denies a push after %s", async (_name, line) => {
    const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
    const result = await handle(event(`${line}\n${PUSH}`), { PATH: "/usr/bin" }, port);
    expect(result.stdout).toContain("nested more than");
  });

  it.each(DEEP)("the built hook in a fresh process denies a push after %s", (_name, line) => {
    const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input: event(`${line}\n${PUSH}`, home), env: { ...process.env, HOME: home }, encoding: "utf-8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('"permissionDecision":"deny"');
  });

  it.each([
    ["$((", (depth: number) => `echo ${nest("$((", "1", "))", depth)}`],
    ["${", (depth: number) => `: ${nest("${", "", "}", depth)}`],
    ["$(", (depth: number) => `echo ${nest("$(", "echo 1", ")", depth)}`],
    ['${x-"', (depth: number) => `: ${nest('${x-"', "", '"}', depth)}`],
  ])("lexes %s nested to the limit", (_name, line) => {
    expect(() => tokenize(line(MAX_NESTING))).not.toThrow();
    expect(() => tokenize(line(MAX_NESTING + 1))).toThrow(/nested more than/);
  });
});

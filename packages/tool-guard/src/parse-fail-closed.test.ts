import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BYPASS_VAR } from "./actor.js";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const ts = new Date("2026-01-02T03:04:05.000Z");
const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};
const port: HookPort = { context: nodeContext(HOME, noFs), now: () => ts, loadDecide: async () => decide };

/** `$(` nested `depth` deep, then the push on the next line. */
const deepThenPush = (depth: number) => `echo ${"$(".repeat(depth)}x${")".repeat(depth)}\ngit push origin HEAD:main`;
/** A quoted subscript assignment whose value nests `$(` `depth` deep, then the push on the same line. */
const quotedSubscriptThenPush = (depth: number) => `a='x['"${"$(".repeat(depth)}[1${")".repeat(depth)}"']'; git push origin HEAD:main`;

/** `$(` nested one past the walk's limit, so the line after it fails to parse. */
const D = `echo ${"$(".repeat(9)}x${")".repeat(9)}\n`;
/** Spellings of a push or merge that no raw-text word check finds, each run by bash. */
const hiddenWords: [string, string][] = [
  ["an ANSI-C letter in push", "git p$'u'sh origin HEAD:main"],
  ["a variable ahead of sh", "a=pu; git ${a}sh origin HEAD:main"],
  ["a backquoted half of push", "git `echo pu`sh origin HEAD:main"],
  ["a substituted half of push", "git $(printf pu)sh origin HEAD:main"],
  ["an ANSI-C hex escape in push", "git $'\\x70ush' origin HEAD:main"],
  ["an empty expansion inside push", "git p${u}ush origin HEAD:main"],
  ["an array joined into push", 'x=(pu sh);git "${x[0]}${x[1]}" origin HEAD:main'],
  ["an ANSI-C letter in gh pr merge", "gh pr mer$'g'e 1"],
  ["an ANSI-C letter in an API merge path", "gh api -X PUT repos/o/r/pulls/1/mer$'g'e"],
];

function bash(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
}

function decisionOf(stdout: string): string | null {
  if (stdout === "") return null;
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout;
}

async function timedDecision(command: string): Promise<{ decision: string | null; ms: number }> {
  const start = performance.now();
  const result = await handle(bash(command), {}, port);
  return { decision: decisionOf(result.stdout), ms: performance.now() - start };
}

const pushShapes: [string, string][] = [
  ["a newline push after $( nested 9 deep", deepThenPush(9)],
  ["a newline push after $( nested 200 deep", deepThenPush(200)],
  ["a quoted subscript nested 8 deep, then a push", quotedSubscriptThenPush(8)],
  ["a quoted subscript nested 9 deep, then a push", quotedSubscriptThenPush(9)],
  ["a quoted subscript nested 12 deep, then a push", quotedSubscriptThenPush(12)],
  ["a quoted subscript nested 100 deep, then a push", quotedSubscriptThenPush(100)],
  ...hiddenWords.map(([name, push]): [string, string] => [`${name} after a line that fails to parse`, D + push]),
];

describe("handle: a command that fails to parse", () => {
  it.each(pushShapes)("denies %s within a second", async (_, command) => {
    const { decision, ms } = await timedDecision(command);

    expect(decision).toBe("deny");
    expect(ms).toBeLessThan(1000);
  });

  it.each(["'", "$(", "`"])("denies git push and gh pr merge followed by an unclosed %s tail", async (tail) => {
    const push = await handle(bash(`git push origin HEAD:main\necho ${tail}x`), {}, port);
    const merge = await handle(bash(`gh pr merge 3\necho ${tail}x`), {}, port);
    const spaced = await handle(bash(`git -C . pu''sh origin HEAD:main; echo ${tail}x`), {}, port);

    expect([push, merge, spaced].map((r) => decisionOf(r.stdout))).toEqual(["deny", "deny", "deny"]);
    expect(push.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "unparsed", "bash.unparsed"]);
  });

  it("passes nested substitutions at the walk limit that run no push", async () => {
    const result = await handle(bash(`echo ${"$(".repeat(8)}x${")".repeat(8)}`), {}, port);

    expect(result).toEqual({ stdout: "", log: [] });
  });

  it("classifies a push after nesting at the walk limit as the push itself", async () => {
    const result = await handle(bash(quotedSubscriptThenPush(8)), {}, port);

    expect(result.log[0]?.split("\t")[4]).toBe("bash.merge.git-push-protected");
  });

  it("denies an unparseable command that names no push or guarded path, and says to simplify it", async () => {
    const result = await handle(bash(`${D}pushd /tmp`), {}, port);

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.stdout).toContain("split it into simpler commands");
    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "unparsed", "bash.unparsed"]);
  });

  it("lets the owner's bypass through an unparseable command, with an error line", async () => {
    const result = await handle(bash(`${D}git push origin HEAD:main`), { [BYPASS_VAR]: "1" }, port);

    expect(result).toEqual({ stdout: "", log: ["2026-01-02T03:04:05.000Z\terror\tparse\tBash\ts"] });
  });
});

// CI builds before it tests; locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-fail-closed-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("the built hook on a command that fails to parse", () => {
  it.each(pushShapes)("denies %s within a second", (_, command) => {
    const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });

    const start = performance.now();
    const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input, env: { ...process.env, HOME: home }, encoding: "utf-8", timeout: 5000 });
    const ms = performance.now() - start;

    expect(run.status).toBe(0);
    expect(decisionOf(run.stdout)).toBe("deny");
    expect(ms).toBeLessThan(1000);
  });
});

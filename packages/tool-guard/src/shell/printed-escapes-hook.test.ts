import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

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

/** bash prints a printf format's `\c` as written, so the receiving shell runs `echo c` and then the guarded command. */
const formatBackslashC = (cmd: string): [string, string][] => [
  ["printf format \\c piped to bash", `printf 'echo \\c; ${cmd}' | bash`],
  ["printf format \\c piped to zsh", `printf 'echo \\c; ${cmd}' | zsh`],
];

/** Both shells print an escaped `%` as written, so it is no directive and eats no argument. */
const escapedPercent = (cmd: string): [string, string][] =>
  ["bash", "zsh"].flatMap((sh): [string, string][] => [
    [`octal \\045 piped to ${sh}`, `printf '\\045.0s\\n%s\\n' '${cmd}' | ${sh}`],
    [`hex \\x25 piped to ${sh}`, `printf '\\x25.0s\\n%s\\n' '${cmd}' | ${sh}`],
  ]);

/** Only bash's or zsh's text of the print holds the command, so the pipe walks each shell's text. */
const oneShellPrints = (cmd: string): [string, string][] => [
  ["bash echo's \\c printed as written, piped to bash", `echo 'echo \\c; ${cmd}' | bash`],
  ["zsh echo's -e beating -E, piped to zsh", `echo -neE '${cmd.replace(" ", "\\x20")}' | zsh`],
];

const both = (rows: (cmd: string) => [string, string][]) => [
  ...rows("git push origin HEAD:main").map(([n, c]) => [`${n} (push)`, c]),
  ...rows("gh pr merge 1 --squash").map(([n, c]) => [`${n} (merge)`, c]),
];

const denyRows = [
  ...both(formatBackslashC),
  ...both(escapedPercent),
  ...both(oneShellPrints),
  ["a format after --, starting with -", "printf -- '-x\\n%s\\n' 'git push origin HEAD:main' | bash"],
];

const passRows: [string, string][] = [["printf format \\c before a git status", "printf 'echo \\c; git status' | bash"]];

function bash(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
}

function decisionOf(stdout: string): string | null {
  if (stdout === "") return null;
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout;
}

describe("a printf format's \\c piped to a shell", () => {
  it.each(denyRows)("denies %s", async (_, command) => {
    const result = await handle(bash(command), {}, port);

    expect(decisionOf(result.stdout)).toBe("deny");
  });

  it.each(passRows)("passes %s", async (_, command) => {
    const result = await handle(bash(command), {}, port);

    expect(decisionOf(result.stdout)).toBeNull();
  });
});

// CI builds before it tests; locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-printed-escapes-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function hook(command: string): string | null {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
  const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input, env: { ...process.env, HOME: home }, encoding: "utf-8", timeout: 5000 });
  expect(run.status).toBe(0);
  return decisionOf(run.stdout);
}

describe("the built hook on a printf format's \\c piped to a shell", () => {
  it.each(denyRows)("denies %s", (_, command) => {
    expect(hook(command)).toBe("deny");
  });

  it.each(passRows)("passes %s", (_, command) => {
    expect(hook(command)).toBeNull();
  });
});

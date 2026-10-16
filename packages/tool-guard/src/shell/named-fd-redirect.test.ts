import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";
import { tokenize } from "./lexer.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: (file) => (file === `${REPO}/x.sh` ? `${PUSH}\n` : file === `${REPO}/ok.sh` ? "echo hi\n" : null),
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(event, { PATH: "/usr/bin" }, port);
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/** Each word as its text, and each redirect as `fd op target`, in order. */
const reading = (line: string): string[] =>
  tokenize(line).flatMap((t) => {
    if (t.type === "word") return [t.value];
    if (t.type === "redirect") return [`${t.fd ?? ""}${t.op} ${t.target?.value ?? ""}`];
    return t.type === "op" ? [t.value] : [];
  });

describe("the lexer reads a glued {name} as a redirect's fd (TP-3279)", () => {
  it.each([
    ["bash {fd}< ./x.sh /dev/fd/10", ["bash", "{fd}< ./x.sh", "/dev/fd/10"]],
    ["bash {fd}<> ./x.sh /dev/fd/10", ["bash", "{fd}<> ./x.sh", "/dev/fd/10"]],
    ["bash {fd}<&3 /dev/fd/10", ["bash", "{fd}<& 3", "/dev/fd/10"]],
    ["exec {fd}>&-", ["exec", "{fd}>& -"]],
    ["exec {_f2}>f", ["exec", "{_f2}> f"]],
  ])("%s", (line, expected) => {
    expect(reading(line)).toEqual(expected);
  });

  it.each([
    ["echo {a,b}<./x.sh", ["echo", "{a,b}", "< ./x.sh"]],
    ["{ bash; } < ./x.sh", ["{", "bash", ";", "}", "< ./x.sh"]],
    ["echo {fd} < ./x.sh", ["echo", "{fd}", "< ./x.sh"]],
    ["echo {f-d}< ./x.sh", ["echo", "{f-d}", "< ./x.sh"]],
    ["echo {1x}< ./x.sh", ["echo", "{1x}", "< ./x.sh"]],
    ["echo {}< ./x.sh", ["echo", "{}", "< ./x.sh"]],
    ["echo \\{fd}< ./x.sh", ["echo", "{fd}", "< ./x.sh"]],
    ["echo '{fd}'< ./x.sh", ["echo", "{fd}", "< ./x.sh"]],
  ])("keeps %s a word, which no shell reads as a named fd", (line, expected) => {
    expect(reading(line)).toEqual(expected);
  });
});

/** Each runs x.sh on a descriptor from 10 up that a `{name}` redirect opened. */
const DENIED = [
  "bash {fd}< ./x.sh /dev/fd/10",
  "bash {fd}<> ./x.sh /dev/fd/10",
  "zsh {fd}< ./x.sh /dev/fd/10",
  "zsh {fd}<> ./x.sh /dev/fd/10",
  "bash {fd}< ./x.sh /dev/fd/11",
  "bash {fd}< ./x.sh /proc/self/fd/10",
  "bash {fd}>> ./x.sh /dev/fd/10",
  "bash -c 'bash {fd}< ./x.sh /dev/fd/10' 10<&-",
];

describe("a shell runs a descriptor a {name} redirect may have opened (TP-3279)", () => {
  it.each(DENIED)("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    "bash {fd}< ./x.sh ./ok.sh",
    "cat {fd}< ./x.sh",
    "exec {fd}< ./x.sh",
    "bash /dev/fd/3 3< ./ok.sh {fd}< ./x.sh",
    "echo {a,b}<./ok.sh",
    "{ bash; } < ./ok.sh",
  ])("allows %s, which runs no shell on that descriptor", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;

/** Runs `line` under `runner` in a scratch dir whose x.sh calls a fake `git`, and reports whether that `git` ran. */
function runsGit(line: string, runner: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-fd-"));
  try {
    fs.writeFileSync(path.join(dir, "x.sh"), `${PUSH}\n`);
    fs.writeFileSync(path.join(dir, "ok.sh"), "true\n");
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh\ntouch '${path.join(dir, "mk")}'\n`, { mode: 0o755 });
    const [program = "bash", ...flags] = runner.split(" ");
    const env = { ...process.env, ZDOTDIR: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` };
    spawnSync(program, [...flags, "-c", line], { cwd: dir, env, stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
    return fs.existsSync(path.join(dir, "mk"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!has("bash") || !has("zsh"))("bash and zsh run the script a {name} redirect opens (TP-3279)", () => {
  it.each(DENIED.filter((line) => !line.includes("/dev/fd/11")))("%s runs x.sh under bash", (line) => {
    expect(runsGit(line, "bash")).toBe(true);
  });

  it.each(["bash {fd}< ./x.sh /dev/fd/11", "zsh -f {fd}< ./x.sh /dev/fd/11", "bash -c 'bash {fd}< ./x.sh /dev/fd/10' 10<&-"])(
    "%s runs x.sh under zsh -f, which keeps fd 10 for itself",
    (line) => {
      expect(runsGit(line, "zsh -f")).toBe(true);
    },
  );

  it.each(["bash {fd}< ./x.sh ./ok.sh", "echo {a,b}<./x.sh", "bash \\{fd}< ./x.sh /dev/fd/10"])("%s runs no x.sh under either", (line) => {
    expect([runsGit(line, "bash"), runsGit(line, "zsh -f")]).toEqual([false, false]);
  });
});

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
  readScript: (file) => ([`${REPO}/x.sh`, `${REPO}/{fd}`].includes(file) ? `${PUSH}\n` : file === `${REPO}/ok.sh` ? "echo hi\n" : null),
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(event, { PATH: "/usr/bin" }, port);
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/** Each word as its text, and each redirect as `fd op target`, its fd the `{name}` it may store into. */
const reading = (line: string): string[] =>
  tokenize(line).flatMap((t) => {
    if (t.type === "word") return [t.value];
    if (t.type === "redirect") return [`${t.named ?? t.fd ?? ""}${t.op} ${t.target?.value ?? ""}`];
    return t.type === "op" ? [t.value] : [];
  });

describe("the lexer reads a {name} before a redirect as the fd it may store (TP-3279)", () => {
  it.each([
    ["bash {fd}< ./x.sh /dev/fd/10", ["bash", "{fd}< ./x.sh", "/dev/fd/10"]],
    ["bash {fd}<> ./x.sh /dev/fd/10", ["bash", "{fd}<> ./x.sh", "/dev/fd/10"]],
    ["bash {fd}<&3 /dev/fd/10", ["bash", "{fd}<& 3", "/dev/fd/10"]],
    ["exec {fd}>&-", ["exec", "{fd}>& -"]],
    ["exec {_f2}>f", ["exec", "{_f2}> f"]],
    ["bash {a[0]}< ./x.sh /dev/fd/10", ["bash", "{a[0]}< ./x.sh", "/dev/fd/10"]],
    ["{fd}< /dev/null git push", ["{fd}< /dev/null", "git", "push"]],
    ["echo {fd} < ./x.sh", ["echo", "{fd}< ./x.sh"]],
  ])("%s", (line, expected) => {
    expect(reading(line)).toEqual(expected);
  });

  it.each([
    ["echo {a,b}<./x.sh", ["echo", "{a,b}", "< ./x.sh"]],
    ["{ bash; } < ./x.sh", ["{", "bash", ";", "}", "< ./x.sh"]],
    ["echo {a[0]} < ./x.sh", ["echo", "{a[0]}", "< ./x.sh"]],
    ["cat < {fd}< ./x.sh", ["cat", "< {fd}", "< ./x.sh"]],
    ["[[ {a} < {b} ]]", ["[[", "{a}", "< {b}", "]]"]],
    ["echo {f-d}< ./x.sh", ["echo", "{f-d}", "< ./x.sh"]],
    ["echo {1x}< ./x.sh", ["echo", "{1x}", "< ./x.sh"]],
    ["echo {}< ./x.sh", ["echo", "{}", "< ./x.sh"]],
    ["echo \\{fd}< ./x.sh", ["echo", "{fd}", "< ./x.sh"]],
    ["echo '{fd}'< ./x.sh", ["echo", "{fd}", "< ./x.sh"]],
  ])("keeps %s a word, which no shell reads as a named fd", (line, expected) => {
    expect(reading(line)).toEqual(expected);
  });

  it("refuses a {name[…]} whose subscript expands, read only at run time", () => {
    expect(() => tokenize("bash {a[$i]}< ./x.sh /dev/fd/10")).toThrow(/run time/);
  });
});

/** Each runs x.sh, or a file named `{fd}`, in bash, zsh or dash: the shell that runs it is in `PREMISES`. */
const DENIED = [
  "bash {fd}< ./x.sh /dev/fd/10",
  "bash {fd}<> ./x.sh /dev/fd/10",
  "zsh {fd}< ./x.sh /dev/fd/10",
  "zsh {fd}<> ./x.sh /dev/fd/10",
  "bash {fd}< ./x.sh /dev/fd/11",
  "bash {fd}< ./x.sh /proc/self/fd/10",
  "bash {fd}>> ./x.sh /dev/fd/10",
  "bash -c 'bash {fd}< ./x.sh /dev/fd/10' 10<&-",
  "bash {a[0]}< ./x.sh /dev/fd/10",
  "bash {fd} < ./x.sh /dev/fd/11",
  "sh {fd}< /dev/null",
  "sh -c 'sh {fd}< /dev/null'",
  `{fd}< /dev/null ${PUSH}`,
  `exec {fd}< /dev/null ${PUSH}`,
  "bash {a[$i]}< ./x.sh /dev/fd/10",
];

describe("a shell runs a descriptor a {name} redirect may have opened (TP-3279)", () => {
  it.each(DENIED)("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    "cat {fd}< ./x.sh",
    "cat {fd} < ./x.sh",
    "exec {fd}< ./x.sh",
    "cat /dev/fd/10 {fd}< ./x.sh",
    "echo {a,b}<./ok.sh",
    "{ bash; } < ./ok.sh",
  ])("allows %s, which runs no shell on that descriptor", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;

/** Runs `line` under `runner` in a scratch dir whose x.sh and `{fd}` call a fake `git`, and reports whether it ran. */
function runsGit(line: string, runner: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-fd-"));
  try {
    for (const script of ["x.sh", "{fd}"]) fs.writeFileSync(path.join(dir, script), `${PUSH}\n`);
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

/** Each denied line, with its setup, under a parent shell that runs the push. zsh keeps fd 10 for itself and opens 11. */
const PREMISES: Array<[string, string]> = [
  ...DENIED.slice(0, 4).map((line): [string, string] => [line, "bash"]),
  ["bash {fd}< ./x.sh /dev/fd/11", "zsh -f"],
  ["zsh -f {fd}< ./x.sh /dev/fd/11", "zsh -f"],
  ...DENIED.slice(5, 8).map((line): [string, string] => [line, "bash"]),
  ["bash -c 'bash {fd}< ./x.sh /dev/fd/10' 10<&-", "zsh -f"],
  ["bash {a[0]}< ./x.sh /dev/fd/10", "bash"],
  ["bash {fd} < ./x.sh /dev/fd/11", "zsh -f"],
  ["sh {fd}< /dev/null", "dash"],
  [`{fd}< /dev/null ${PUSH}`, "bash"],
  [`exec {fd}< /dev/null ${PUSH}`, "zsh -f"],
  ["i=0; bash {a[$i]}< ./x.sh /dev/fd/10", "bash"],
];

describe.skipIf(!["bash", "zsh", "dash"].every(has))("bash, zsh and dash run what the denied lines hold (TP-3279)", () => {
  it.each(PREMISES)("%s runs the push under %s", (line, runner) => {
    expect(runsGit(line, runner)).toBe(true);
  });

  it.each(["echo {a,b}<./x.sh", "bash /dev/fd/10 \\{fd}< ./x.sh", "cat {fd} < ./x.sh"])("%s runs no push under any of them", (line) => {
    expect(["bash", "zsh -f", "dash"].map((runner) => runsGit(line, runner))).toEqual([false, false, false]);
  });
});

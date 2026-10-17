import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifyContext } from "../types.js";
import { extractCommands } from "./commands.js";
import { tokenize } from "./lexer.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  // `{x}` links to the repo in the premises, so a `cd` into it pushes main.
  readHead: (dir) => (dir === REPO || dir === `${REPO}/{x}` ? "main" : null),
  // `{fd}` is harmless, so a line using it is refused for the redirect; `{run}` holds the push dash's reading runs.
  readScript: (file) => ([`${REPO}/x.sh`, `${REPO}/{run}`].includes(file) ? `${PUSH}\n` : [`${REPO}/ok.sh`, `${REPO}/{fd}`].includes(file) ? "echo hi\n" : null),
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(event, { PATH: "/usr/bin" }, port);
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/** Each word as its text, a `{name}` the shells may read as a descriptor in parentheses, and each redirect as `fd op target`. */
const reading = (line: string): string[] =>
  tokenize(line).flatMap((t) => {
    if (t.type === "word") return [t.namedFd ? `(${t.value})` : t.value];
    if (t.type === "redirect") return [`${t.fd ?? ""}${t.op} ${t.target?.value ?? ""}`];
    return t.type === "op" ? [t.value] : [];
  });

describe("the lexer marks a {name} before a redirect, which the shells read two ways (TP-3279)", () => {
  it.each([
    ["bash {fd}< ./x.sh /dev/fd/10", ["bash", "({fd})", "< ./x.sh", "/dev/fd/10"]],
    ["bash {fd}<> ./x.sh /dev/fd/10", ["bash", "({fd})", "<> ./x.sh", "/dev/fd/10"]],
    ["bash {fd}<&3 /dev/fd/10", ["bash", "({fd})", "<& 3", "/dev/fd/10"]],
    ["exec {fd}>&-", ["exec", "({fd})", ">& -"]],
    ["exec {_f2}>f", ["exec", "({_f2})", "> f"]],
    ["bash {a[0]}< ./x.sh /dev/fd/10", ["bash", "({a[0]})", "< ./x.sh", "/dev/fd/10"]],
    ["bash {a[$i]}< ./x.sh /dev/fd/10", ["bash", "({a[$i]})", "< ./x.sh", "/dev/fd/10"]],
    ["echo {fd} < ./x.sh", ["echo", "({fd})", "< ./x.sh"]],
  ])("%s", (line, expected) => {
    expect(reading(line)).toEqual(expected);
  });

  it.each([
    ["echo {a,b}<./x.sh", ["echo", "{a,b}", "< ./x.sh"]],
    ["{ bash; } < ./x.sh", ["{", "bash", ";", "}", "< ./x.sh"]],
    ["echo {a[0]} < ./x.sh", ["echo", "{a[0]}", "< ./x.sh"]],
    ["cat < {fd}< ./x.sh", ["cat", "< {fd}", "< ./x.sh"]],
    ["echo {fd} 2< ./x.sh", ["echo", "{fd}", "2< ./x.sh"]],
    ["cat {fd}<(echo hi)", ["cat", "{fd}"]],
    ["[[ {a} < {b} ]]", ["[[", "{a}", "< {b}", "]]"]],
    ["echo {f-d}< ./x.sh", ["echo", "{f-d}", "< ./x.sh"]],
    ["echo {1x}< ./x.sh", ["echo", "{1x}", "< ./x.sh"]],
    ["echo {}< ./x.sh", ["echo", "{}", "< ./x.sh"]],
    ["echo \\{fd}< ./x.sh", ["echo", "{fd}", "< ./x.sh"]],
    ["echo '{fd}'< ./x.sh", ["echo", "{fd}", "< ./x.sh"]],
  ])("keeps %s a plain word, which no shell reads as a named fd", (line, expected) => {
    expect(reading(line)).toEqual(expected);
  });
});

describe("the walk emits a command with a {name} redirect under both readings (TP-3279)", () => {
  const show = (line: string): string[] =>
    extractCommands(line, { cwd: REPO, home: "/home/you" }).map((c) => [c.name, ...c.args.map((a) => a.value), ...c.redirects.map((r) => `${r.fd ?? ""}${r.op}`)].join(" "));

  it.each([
    ["echo {fd}< ./x.sh", ["echo {fd} <", "echo {fd}<"]],
    ["{fd}< /dev/null git push", ["{fd} git push <", "git push {fd}<"]],
    ["env -C {x} </dev/null git push", ["git push <", "push {x}<"]],
  ])("%s keeps the word as dash does, then reads it as the fd", (line, expected) => {
    expect(show(line)).toEqual(expected);
  });
});

/** Each runs x.sh, or the file `{run}`, in bash, zsh or dash: the shell that runs it is in `PREMISES`. */
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
  "bash {a[$i]}< ./x.sh /dev/fd/10",
  "bash {fd} < ./x.sh /dev/fd/11",
  "sh {run}< /dev/null",
  "sh -c 'sh {run}< /dev/null'",
  `{fd}< /dev/null ${PUSH}`,
  `exec {fd}< /dev/null ${PUSH}`,
  `bash -c 'eval "bash /dev/fd/10" {fd}< ./x.sh' 10<&-`,
  `env -C {x} </dev/null ${PUSH}`,
  `git -C {x} </dev/null push origin HEAD:main`,
  `sh -c 'env -C {x}</dev/null ${PUSH}'`,
];

/** The word's reading prints the push, or moves into the repo, that the fd's reading would hand on without. */
const HANDED_ON = [
  `echo env -C {x} </dev/null ${PUSH} | sh`,
  `printf '%s ' env -C {x} </dev/null ${PUSH} | sh`,
  `printf '%.0s%s\\n' {x} </dev/null '${PUSH}' | bash`,
  `{ echo env -C {x} </dev/null ${PUSH}; } | sh`,
  "cd {x} </dev/null; git push",
  `printf '%.0s%s\\n' {x} </dev/null 'push origin HEAD:main' | xargs git`,
  `printf '%.0s%s\\n' {x} </dev/null '${PUSH}' | xargs -I{} sh -c {}`,
  `echo env -C {x} </dev/null ${PUSH} | cat | sh`,
  `echo env -C {x} </dev/null ${PUSH} | cat - | bash`,
  `echo env -C {x} </dev/null ${PUSH} | tee /dev/null | sh`,
];

describe("a shell runs a descriptor a {name} redirect may have opened (TP-3279)", () => {
  it.each([...DENIED, ...HANDED_ON])("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    "bash {fd}< ./x.sh ./ok.sh",
    "cat {fd}< ./x.sh",
    "cat {fd} < ./x.sh",
    "exec {fd}< ./x.sh",
    "cat /dev/fd/10 {fd}< ./x.sh",
    "echo {a,b}<./ok.sh",
    "{ bash; } < ./ok.sh",
    "echo {x} </dev/null | cat",
    "printf '%s\\n' {a} </dev/null | grep a",
    "echo hi | sh",
    "exec {fd}</dev/null",
    "cat {fd}< ./notes.txt",
    "cd {x} </dev/null; ls",
    "echo {x} </dev/null | xargs echo",
    "printf '%s\\n' {a} {b} | cat | sort",
    "echo hi | cat | sh",
  ])("allows %s, which runs no shell on that descriptor", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;

/** Runs `line` under `runner` in a scratch dir whose x.sh and `{run}` call a fake `git`, and reports whether it ran. */
function runsGit(line: string, runner: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-fd-"));
  try {
    for (const script of ["x.sh", "{run}"]) fs.writeFileSync(path.join(dir, script), `${PUSH}\n`);
    for (const script of ["ok.sh", "{fd}"]) fs.writeFileSync(path.join(dir, script), "true\n");
    fs.symlinkSync(".", path.join(dir, "{x}"));
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

/**
 * Each denied line, with its setup, under a parent shell that runs the push. zsh keeps fd 10 for itself and opens 11.
 * `sh -c` rows depend on which shell `sh` is, so dash runs their inner text directly.
 */
const PREMISES: Array<[string, string]> = [
  ...DENIED.slice(0, 4).map((line): [string, string] => [line, "bash"]),
  ...["bash {fd}< ./x.sh /dev/fd/11", "zsh -f {fd}< ./x.sh /dev/fd/11"].map((line): [string, string] => [line, "zsh -f"]),
  ...DENIED.slice(5, 9).map((line): [string, string] => [line, "bash"]),
  ["bash -c 'bash {fd}< ./x.sh /dev/fd/10' 10<&-", "zsh -f"],
  ["i=0; bash {a[$i]}< ./x.sh /dev/fd/10", "bash"],
  ["bash {fd} < ./x.sh /dev/fd/11", "zsh -f"],
  ["sh {run}< /dev/null", "dash"],
  [`{fd}< /dev/null ${PUSH}`, "bash"],
  [`exec {fd}< /dev/null ${PUSH}`, "zsh -f"],
  ...DENIED.slice(15, 18).map((line): [string, string] => [line, "bash"]),
  [`env -C {x}</dev/null ${PUSH}`, "dash"],
  ...HANDED_ON.flatMap((line): Array<[string, string]> => [[line, "bash"], [line, "dash"]]),
];

describe.skipIf(!["bash", "zsh", "dash"].every(has))("bash, zsh and dash run what the denied lines hold (TP-3279)", () => {
  it.each(PREMISES)("%s runs the push under %s", (line, runner) => {
    expect(runsGit(line, runner)).toBe(true);
  });

  it.each(["bash {fd}< ./x.sh ./ok.sh", "echo {a,b}<./x.sh", "bash /dev/fd/10 \\{fd}< ./x.sh", "cat {fd} < ./x.sh"])("%s runs no push under any of them", (line) => {
    expect(["bash", "zsh -f", "dash"].map((runner) => runsGit(line, runner))).toEqual([false, false, false]);
  });
});

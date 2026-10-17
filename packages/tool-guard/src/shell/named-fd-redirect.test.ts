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
  // `{x}` is a directory in the repo in the premises, so a `cd` into it pushes main.
  readHead: (dir) => ([REPO, `${REPO}/{x}`, "/home/you/repo"].includes(dir) ? "main" : dir === `${REPO}/{x}/repo` ? "work" : null),
  // `{fd}` is harmless, so a line using it is refused for the redirect; `{run}` holds the push dash's reading runs.
  readScript: (file) => ([`${REPO}/x.sh`, `${REPO}/{x}/x.sh`, `${REPO}/{run}`, "/home/you/s.sh"].includes(file) ? `${PUSH}\n` : [`${REPO}/ok.sh`, `${REPO}/{fd}`].includes(file) ? "echo hi\n" : null),
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

/** bash reads a glued `{fd}<` as the fd and keeps a spaced `{x} <` a word, which neither zsh's reading nor dash's does. */
const MIXED = [
  "env -C {x} </dev/null {fd}< ./x.sh bash /dev/fd/10",
  "{fd}< ./x.sh env -C {x} </dev/null bash /dev/fd/10",
  "env --chdir {x} </dev/null {fd}< ./x.sh sh /dev/fd/10",
];

/** One reading stores the script, or moves to where `../x.sh` is x.sh, that the others do not; the rest of the line runs in each. */
const DISPUTED = [
  `printf -v V '%.0s%s' {x} </dev/null ./x.sh; bash "$V"`,
  `printf -v V '%.0s%s' {x} </dev/null ./x.sh; sh "$V"`,
  `printf -v V '%.0s%s' {x} </dev/null ./x.sh; source "$V"`,
  `printf -v V '%.0s%s' {x} </dev/null {fd}</dev/null ./x.sh; bash "$V"`,
  "cd {x} </dev/null; bash ../x.sh",
  "cd {x} </dev/null; sh ../x.sh",
  "cd {x} </dev/null; source ../x.sh",
  "cd {x} </dev/null; bash ./x.sh",
  "cd {x} </dev/null && bash ./x.sh",
  "pushd {x} </dev/null; bash ./x.sh",
  "cd {x} </dev/null; sh x.sh",
  "cd {x} </dev/null; source ./x.sh",
  "cd {x} </dev/null; bash -s < ./x.sh",
  "cd {x} </dev/null; cd ..; bash ./x.sh",
  "A=x.sh; A=f {x} </dev/null; bash $A",
  "A=x.sh; A=f {fd}< /dev/null; bash $A",
  "A=x.sh; A= {fd}< /dev/null; bash $A",
];

/**
 * Each reading forks with its own `&&` chain, so a branch created in one reading is not trusted by a later command the
 * other reading runs. In bash, `repo` is `{x}/repo`, a worktree of ~/repo; zsh's `cd {x} </dev/null` reaches ~ instead.
 * The first line is the regression: zsh creates feat in ~/repo and the merge there is fine, but the bash fork creates
 * feat in {x}/repo, so its merge into ~/repo must not be trusted. The `;` form shows a dropped chain stays strict too.
 */
const READING_STATES = [
  "cd {x} </dev/null && git -C repo checkout -b feat && git -C ~/repo merge feat",
  "cd {x} </dev/null; git -C repo checkout -b feat && git -C ~/repo merge feat",
];

/**
 * A `{name}` reading forks the rest of a `{ }` group or `( )` subshell opened before it; the fork must still pipe the
 * group's text on. Here only the bash fork, where `{x}` is a word and the `A=f` prefix does not persist, prints `bash x.sh`.
 */
const FORK_GROUP = [
  `A=x.sh; { true; A=f {x} </dev/null; echo "bash $A"; } | sh`,
  `A=x.sh; ( true; A=f {x} </dev/null; echo "bash $A" ) | sh`,
];

/** Readings that agree on a variable leave it known, so the script it names is still read. */
const AGREED = [`B=./x.sh; true {a}</dev/null {b} </dev/null; bash "$B"`];

describe("a shell runs a descriptor a {name} redirect may have opened (TP-3279)", () => {
  it.each([...DENIED, ...HANDED_ON, ...MIXED, ...DISPUTED, ...AGREED, ...READING_STATES, ...FORK_GROUP])("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it("refuses a line whose disputed readings would walk its rest more than the cap allows", async () => {
    expect(await verdict(`${"cd {x} </dev/null; ".repeat(4)}ls`)).toBe("deny");
    expect(await verdict(`${"cd {x} </dev/null; ".repeat(3)}ls`)).toBe("pass");
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
    "env -C {x} </dev/null git status",
    "cat {fd}<./ok.sh /dev/fd/10 | wc -l; git diff",
    "exec {fd}</dev/null; git status",
    "cd {x} </dev/null; git log -1",
    "cd ./{x} && true {a}</dev/null {b} </dev/null && git status",
    `B=./ok.sh; true {a}</dev/null {b} </dev/null; bash "$B"`,
    "cd {x} </dev/null; git status",
    "printf -v V '%s' ok; bash ./ok.sh",
    "A=HEAD:main {fd}< /dev/null; git status",
    "true {a}</dev/null {b} </dev/null && git -C ~/repo checkout -b feat && git -C ~/repo merge feat",
    "cd ~ && git -C repo checkout -b feat && git -C ~/repo merge feat",
    `A=x.sh; { true; A=f {x} </dev/null; echo "git status"; } | sh`,
    "echo x | { cat; }",
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
    fs.mkdirSync(path.join(dir, "{x}"));
    fs.writeFileSync(path.join(dir, "{x}", "x.sh"), `${PUSH}\n`);
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
  ...MIXED.map((line): [string, string] => [line, "bash"]),
  ...DISPUTED.slice(0, 15).map((line): [string, string] => [line, "bash"]),
  ...["cd {x} </dev/null; bash ../x.sh", "cd {x} </dev/null; bash ./x.sh", ...DISPUTED.slice(14)].map((line): [string, string] => [line, "dash"]),
  ...AGREED.map((line): [string, string] => [line, "bash"]),
  ...FORK_GROUP.flatMap((line): Array<[string, string]> => [[line, "bash"], [line, "dash"]]),
];

describe.skipIf(!["bash", "zsh", "dash"].every(has))("bash, zsh and dash run what the denied lines hold (TP-3279)", () => {
  it.each(PREMISES)("%s runs the push under %s", (line, runner) => {
    expect(runsGit(line, runner)).toBe(true);
  });

  it.each(["bash {fd}< ./x.sh ./ok.sh", "echo {a,b}<./x.sh", "bash /dev/fd/10 \\{fd}< ./x.sh", "cat {fd} < ./x.sh"])("%s runs no push under any of them", (line) => {
    expect(["bash", "zsh -f", "dash"].map((runner) => runsGit(line, runner))).toEqual([false, false, false]);
  });
});

/** bash and zsh read the glued `{fd}<` as the fd, so the group, subshell or substitution prints the push itself. */
const PRINTED_GLUED = [
  `{ echo {fd}</dev/null ${PUSH}; } | bash`,
  `( echo {fd}</dev/null ${PUSH} ) | sh`,
  `bash -c "$(echo {fd}</dev/null ${PUSH})"`,
  `eval "$(echo {fd}</dev/null ${PUSH})"`,
  `bash < <(echo {fd}</dev/null ${PUSH})`,
  `sh < <(echo {fd}</dev/null ${PUSH})`,
  `sh -c "\`echo {fd}</dev/null ${PUSH}\`"`,
  `{ echo {fd}</dev/null ${PUSH}; } | cat | sh`,
  `{ echo {fd}</dev/null ${PUSH}; } | xargs -I{} sh -c {}`,
];

/** Only zsh reads the spaced `{x} <` as the fd, so only zsh prints the push. */
const PRINTED_SPACED = [
  `{ echo {x} </dev/null ${PUSH}; } | sh`,
  `( echo {x} </dev/null ${PUSH} ) | sh`,
  `eval "$(echo {x} </dev/null ${PUSH})"`,
  `bash -c "$(echo {fd}</dev/null {x} </dev/null ${PUSH})"`,
];

describe("the text a group or substitution prints takes each shell's reading of a {name} redirect (TP-3308)", () => {
  it.each([...PRINTED_GLUED, ...PRINTED_SPACED])("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it.each([
    "{ echo {x} </dev/null; } | cat",
    'echo "$(echo {a})"',
    "{ echo hi; } | sh",
    "( echo {x} </dev/null; ls ) | cat",
    'echo "$(cat {fd}< ./ok.sh)"',
    "cd {x} </dev/null; git status",
    'echo "$(echo {x} </dev/null)"',
    "{ echo {fd}</dev/null hello; } | cat",
    "( printf '%s\\n' {fd}</dev/null a b ) | sort",
    "cat < <(echo {fd}</dev/null hello)",
    'bash -c "$(echo {fd}</dev/null echo hi)"',
    "{ echo {fd}</dev/null ls; } | sh",
    'eval "$(echo {x} </dev/null ls -la)"',
    "{ echo {a,b}; } | cat",
    "diff <(echo {a}) <(echo {b})",
    "{ find . -name '*.ts' -exec grep -l foo {} +; } | head",
    "echo \"$(git log -1 --format='{%h %s}')\"",
    "{ jq '{a:1}' ./ok.json; } | cat",
  ])("allows %s", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

describe.skipIf(!["bash", "dash"].every(has))("bash prints the push a glued {fd}< hides, where dash keeps the word (TP-3308)", () => {
  it.each(PRINTED_GLUED)("%s", (line) => {
    expect(["bash", "dash"].map((runner) => runsGit(line, runner))).toEqual([true, false]);
  });
});

describe.skipIf(!["bash", "zsh", "dash"].every(has))("zsh alone prints the push a spaced {x} < hides (TP-3308)", () => {
  it.each(PRINTED_SPACED)("%s", (line) => {
    expect(["zsh -f", "bash", "dash"].map((runner) => runsGit(line, runner))).toEqual([true, false, false]);
  });
});

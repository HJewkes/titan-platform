import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";
import type { ClassifyContext } from "./types.js";

const REPO = "/home/you/projects/app";
const PUSH = "git push --no-verify origin HEAD:main";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: (file) => (file === `${REPO}/x.sh` ? `${PUSH}\n` : [`${REPO}/ok.sh`, `${REPO}/f`].includes(file) ? "echo hi\n" : null),
};

async function verdict(command: string): Promise<"deny" | "pass"> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const event = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const { stdout } = await handle(event, { PATH: "/usr/bin" }, port);
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : "pass";
}

/** Each opens a read fd or swaps stdin, then a shell or `source` runs x.sh on it where the line does not show the fd. */
const RUN_TIME_OPERAND = [
  "exec {fd}< ./x.sh; bash /dev/fd/$fd",
  "exec {fd}< ./x.sh; source /dev/fd/$fd",
  "exec {fd}< ./x.sh; . /dev/fd/$fd",
  "exec {fd}< ./x.sh; bash /proc/self/fd/$fd",
  'exec {fd}< ./x.sh; bash "/dev/fd/${fd}"',
  "exec {fd}< ./x.sh; bash /dev/fd/$((fd))",
  "exec {fd}< ./x.sh; bash -x /dev/fd/$fd",
  "exec {fd}< ./x.sh; env bash /dev/fd/$fd",
  "exec {fd}< ./x.sh; /bin/bash /dev/fd/$fd",
  "exec {fd}< ./x.sh; zsh /dev/fd/$fd",
  "exec {fd}< ./x.sh; sh /dev/fd/$fd",
  'exec {fd}< ./x.sh; eval "bash /dev/fd/$fd"',
  "exec {fd}< ./x.sh; exec bash /dev/fd/$fd",
  "exec {fd}< ./x.sh && bash /dev/fd/$fd",
  "{ exec {fd}< ./x.sh; bash /dev/fd/$fd; }",
  "( exec {fd}< ./x.sh; bash /dev/fd/$fd )",
  "exec {fd}< ./x.sh; bash /dev/fd/1?",
  "exec {fd}< ./x.sh; echo | xargs -I{} bash /dev/fd/$fd",
  "bash -c 'exec {fd}< ./x.sh; bash /dev/fd/$fd'",
];

/** bash keeps a `{name}` fd open on a builtin, a function or a group; the walker reads `exec {fd}<` the same way. */
const NAMED_ON_COMMAND = [
  "true {fd}< ./x.sh; bash /dev/fd/$fd",
  ": {fd}< ./x.sh; bash /dev/fd/$fd",
  "f() { :; }; f {fd}< ./x.sh; bash /dev/fd/$fd",
  "{ true; } {fd}< ./x.sh; bash /dev/fd/$fd",
  "A=1 true {fd}< ./x.sh; bash /dev/fd/$fd",
  'true {fd}< ./x.sh; bash "$S"',
  'f() { :; }; f {fd}< ./x.sh; bash "$S"',
  'cat {fd}< ./x.sh; bash "$S"',
  "{ true; } {fd}< ./x.sh; F=/dev/fd/$fd; bash $F",
];

/** The outer redirect closes the fd the descriptor view tracks, but the inner `exec` opens it again. */
const INNER_EXEC = [
  "bash -c 'exec 3< ./x.sh; bash /dev/fd/3' 3<&-",
  "bash -c 'exec 3< ./x.sh; bash /dev/fd/3' 3< /dev/null",
  "bash -c 'exec 3< ./x.sh; bash /dev/fd/3' 4<&-",
  "bash -c 'exec 4< ./x.sh; bash /dev/fd/4' 4<&-",
  "bash -c 'exec 3< ./x.sh; . /dev/fd/3' 3<&-",
  "sh -c 'exec 3< ./x.sh; sh /dev/fd/3' 3<&-",
  "bash -c 'exec {fd}< ./x.sh; bash /dev/fd/10' 10<&-",
  "exec 3< ./x.sh; bash /proc/self/fd/3",
];

/** The operand is a variable the line built, or the fd is opened after (or around) the shell that uses it. */
const INDIRECT = [
  "exec {fd}< ./x.sh; F=/dev/fd/$fd; bash $F",
  "exec {fd}< ./x.sh; bash \"$S\"",
  "exec 3< ./x.sh; sh \"$S\"",
  "while :; do bash /dev/fd/$fd; done {fd}< ./x.sh",
  "while :; do bash /dev/fd/$fd; exec {fd}< ./x.sh; done",
  'while :; do bash "$S"; done {fd}< ./x.sh',
  'while :; do bash "$S"; exec {fd}< ./x.sh; done',
  'while :; do exec < ./x.sh; done; bash',
];

const SWAPPED_STDIN = [
  "exec < ./x.sh; bash",
  "exec 0< ./x.sh; bash",
  "exec < ./x.sh; bash -s",
  "exec < ./x.sh; sh",
  "exec < ./x.sh; bash /dev/stdin",
  "exec < ./x.sh; source /dev/stdin",
  "exec 3< ./x.sh; exec <&3; bash",
];

/** Already refused before this change; pinned so the new check cannot loosen them. */
const ALREADY_DENIED = [
  "A=x.sh {fd}< /dev/null; bash $A",
  "exec {fd}< ./x.sh; bash /dev/fd/10",
  "exec {fd}< ./x.sh; bash <&$fd",
  "exec 3< ./x.sh; bash /dev/fd/3",
  "exec 3< ./x.sh; bash <&3",
];

describe("a shell runs an fd the line opened for reading (TP-3314)", () => {
  it.each([...RUN_TIME_OPERAND, ...NAMED_ON_COMMAND, ...INNER_EXEC, ...INDIRECT, ...SWAPPED_STDIN, ...ALREADY_DENIED])("denies %s", async (line) => {
    expect(await verdict(line)).toBe("deny");
  });

  it("refuses a run-time fd operand with nothing opened, as it does a literal one", async () => {
    expect(await verdict("bash /dev/fd/$fd")).toBe("deny");
    expect(await verdict("bash /dev/fd/10")).toBe("deny");
  });

  it.each([
    "exec {fd}<f; read -r -u \"$fd\" l",
    'exec {fd}< f; cat <&"$fd"',
    "exec {fd}< f; while read -r -u \"$fd\" l; do echo \"$l\"; done",
    "exec {fd}< f; exec {fd}<&-",
    "exec 3>&1",
    "exec {fd}>log; echo hi >&$fd",
    "exec >log 2>&1; make",
    "while read -u 3 l; do echo $l; done 3< f",
    "exec < f; while read l; do echo $l; done",
    "exec < f; bash -c 'echo hi'",
    "exec < f; bash ./ok.sh",
    "exec < f; echo hi | bash -s",
    "exec < f; bash < ./ok.sh",
    "{ bash; } < ./ok.sh",
    "( bash ) < ./ok.sh",
    "while read l; do bash; done < f",
    "exec 3< f; bash ./ok.sh",
    "exec {fd}< f; bash ./ok.sh",
    "exec {fd}< f; source ./ok.sh",
    "bash /dev/fd/3 3< ./ok.sh",
    "exec 3>&1; bash ./ok.sh",
    "bash ./ok.sh",
    "bash \"$S\"",
    "exec 3>&1; bash \"$S\"",
    "exec >log; sh \"$S\"",
    "bash -c 'echo hi' /dev/fd/$fd",
    "cat /dev/fd/$fd",
    "exec {fd}< f; cat /dev/fd/$fd",
    "exec {fd}< f; python3 ./ok.py",
  ])("allows %s, which runs no shell on an fd it opened", async (line) => {
    expect(await verdict(line)).toBe("pass");
  });
});

const has = (shell: string): boolean => spawnSync(shell, ["-c", "true"]).status === 0;

/** Runs `line` under `runner` in a scratch dir whose x.sh calls a fake `git`, and reports whether it ran. */
function runsGit(line: string, runner: string): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-scripts-"));
  try {
    fs.writeFileSync(path.join(dir, "x.sh"), `${PUSH}\n`);
    fs.writeFileSync(path.join(dir, "f"), "true\n");
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh\ntouch '${path.join(dir, "mk")}'\n`, { mode: 0o755 });
    const [program = "bash", ...flags] = runner.split(" ");
    const env = { ...process.env, ZDOTDIR: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` };
    spawnSync(program, [...flags, "-c", line], { cwd: dir, env, stdio: "ignore", timeout: 10_000 });
    return fs.existsSync(path.join(dir, "mk"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Denied lines whose push a real shell runs; the shells besides bash are those whose fd numbering the row does not depend on. */
const PREMISES: Array<[string, string[]]> = [
  ["exec {fd}< ./x.sh; bash /dev/fd/$fd", ["bash", "zsh -f"]],
  ["exec {fd}< ./x.sh; source /dev/fd/$fd", ["bash", "zsh -f"]],
  ["exec {fd}< ./x.sh; bash /proc/self/fd/$fd", ["bash", "zsh -f"]],
  ['exec {fd}< ./x.sh; eval "bash /dev/fd/$fd"', ["bash", "zsh -f"]],
  ["exec {fd}< ./x.sh; env bash /dev/fd/$fd", ["bash", "zsh -f"]],
  ["true {fd}< ./x.sh; bash /dev/fd/$fd", ["bash", "zsh -f"]],
  ["f() { :; }; f {fd}< ./x.sh; bash /dev/fd/$fd", ["bash", "zsh -f"]],
  ["exec {fd}< ./x.sh; F=/dev/fd/$fd; bash $F", ["bash", "zsh -f"]],
  ["bash -c 'exec 3< ./x.sh; bash /dev/fd/3' 3<&-", ["bash"]],
  ["bash -c 'exec 3< ./x.sh; bash /dev/fd/3' 3< /dev/null", ["bash"]],
  ["bash -c 'exec {fd}< ./x.sh; bash /dev/fd/10' 10<&-", ["bash"]],
  ["exec < ./x.sh; bash", ["bash", "zsh -f", "dash"]],
  ["exec < ./x.sh; bash -s", ["bash", "zsh -f", "dash"]],
  ["exec 3< ./x.sh; exec <&3; bash", ["bash", "zsh -f", "dash"]],
];

describe.skipIf(!["bash", "zsh", "dash"].every(has))("bash and zsh run the push the denied lines hide (TP-3314)", () => {
  it.each(PREMISES.flatMap(([line, runners]) => runners.map((runner): [string, string] => [line, runner])))("%s runs the push under %s", (line, runner) => {
    expect(runsGit(line, runner)).toBe(true);
  });

  it("keeps no fd open for an assignment-only {name} redirect, so that clause adds nothing to hide", () => {
    expect(runsGit("A=1 {fd}< ./x.sh; bash /dev/fd/$fd", "bash")).toBe(false);
  });

  it.each(["exec {fd}< f; read -r -u \"$fd\" l", "exec 3>&1; bash ./f"])("%s runs no push", (line) => {
    expect(runsGit(line, "bash")).toBe(false);
  });
});

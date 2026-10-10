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

const REPO = "/home/you/projects/app";
const PUSH = "git push origin HEAD:main";
const MERGE = "gh pr merge 1 --squash";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};

function event(command: string, cwd = REPO): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd, tool_input: { command } });
}

async function hookDenies(command: string): Promise<boolean> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  return (await handle(event(command), { PATH: "/usr/bin" }, port)).stdout !== "";
}

// The built bundle loads its modules in another order than vitest does; CI builds before it tests, locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-braces-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function builtHookStdout(command: string): string {
  const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input: event(command, home), env: { ...process.env, HOME: home }, encoding: "utf-8" });
  expect(run.status).toBe(0);
  return run.stdout;
}

/** Each opener ends where bash ends it, so the line after it runs; `tail` closes whatever quote a wrong reading left open. */
const OPENERS: Array<[string, string, string]> = [
  ["the reviewer's probe", `: \${x:-$(echo "}'")}`, "#'"],
  ['a "}" operand', ': ${x:-"}"}', '#"'],
  ["a '}' operand", ": ${x:-'}'}", "#'"],
  ["a '}' operand inside double quotes", `: "\${x:-'}'}"`, `#'"`],
  ["a $'}' operand", ": ${x:-$'}'}", "#'"],
  ["a } inside a quoted command substitution", ': ${x:-"$(echo })"}', '#"'],
  ["a } inside a backtick substitution", ": ${x:-`echo }`}", "#`"],
  ["a quoted } inside a nested parameter", ': ${a:-${b:-"}}"}}', '#"'],
  ["an arithmetic expansion before a quoted }", ': ${x:-$((1+2))"}"}', '#"'],
  ["an unquoted { that bash does not nest", ": ${x:-{}", "#}"],
];

describe("a } that bash reads as quoted inside ${…}", () => {
  it.each(OPENERS)("the hook denies a push after %s", async (_name, opener, tail) => {
    expect(await hookDenies(`${opener}\n${PUSH}\n${tail}`)).toBe(true);
  });

  it.each(OPENERS)("the hook denies a merge after %s", async (_name, opener, tail) => {
    expect(await hookDenies(`${opener}\n${MERGE}\n${tail}`)).toBe(true);
  });

  it.each([
    ["a push", PUSH],
    ["a merge", MERGE],
  ])("the built hook denies %s after the reviewer's probe", (_name, guarded) => {
    expect(builtHookStdout(`: \${x:-$(echo "}'")}\n${guarded}\n#'`)).toContain('"permissionDecision":"deny"');
  });

  it("the hook refuses a } inside a process substitution, which bash 3.2 reads as the end", async () => {
    const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
    const result = await handle(event(`: \${x:-<(echo })}\n${PUSH}\n#)`), { PATH: "/usr/bin" }, port);
    expect(result.stdout).toContain("move the process substitution out of the parameter");
  });
});

describe("where the lexer ends ${…}", () => {
  it.each([
    ["an escaped }", "echo ${x:-\\}} END", "${x:-\\}}"],
    ["a quoted }", 'echo ${x:-"}"} END', '${x:-"}"}'],
    ["a single-quoted }", "echo ${x:-'}'} END", "${x:-'}'}"],
    ["a } in a nested substitution", 'echo ${x:-"$(echo })"} END', '${x:-"$(echo })"}'],
    ["a nested parameter", 'echo ${a:-${b:-"}"}} END', '${a:-${b:-"}"}}'],
    ["an arithmetic expansion", "echo ${x:-$((1+${y:-2}))} END", "${x:-$((1+${y:-2}))}"],
    ["an unquoted {", "echo ${x:-{a} END", "${x:-{a}"],
  ])("reads %s inside the parameter", (_name, command, parameter) => {
    const words = tokenize(command).map((t) => (t.type === "word" ? t.value : t.type));
    expect(words).toEqual(["echo", parameter, "END"]);
  });

  it("reads a quoted ) inside an arithmetic expansion", () => {
    const words = tokenize('echo $((1+")")) END').map((t) => (t.type === "word" ? t.value : t.type));
    expect(words).toEqual(["echo", '$((1+")"))', "END"]);
  });

  it("still finds a command substitution inside a quoted operand", () => {
    const [, word] = tokenize(`echo "\${x:-'$(${PUSH})'}"`);
    expect(word?.type === "word" && word.subs.length).toBe(1);
  });
});

describe("ordinary ${…} usage", () => {
  it.each([
    "echo ${x:-default}",
    'echo "${x:-a b}"',
    "echo ${x:0:3} ${#x} ${x#*/} ${x%.*}",
    'echo "${x//"a"/b}"',
    `echo "\${x/'a'/"}"}"`,
    'echo "${files[@]}"',
    'echo "${x:-$(date)}"',
    "echo $(( ${x:-1} + 2 ))",
    'echo "${HOME}/${name:-app}.log"',
    "echo ${x-<(echo ${y})}",
    "echo $(( (1+2) )) ${x-$(( (1+2)*2 ))}",
  ])("passes %s", async (command) => {
    expect(await hookDenies(command)).toBe(false);
  });
});

/** Bash reads `$((` as arithmetic only when the `)` matching its second `(` is followed by another `)`. */
const SUBSHELLS: Array<[string, (guarded: string) => string]> = [
  ["$((…); …)", (g) => `echo $((echo a); ${g})`],
  ['"$((…); …)"', (g) => `echo "$((echo a); ${g})"`],
  ["${x-$((…); …)}", (g) => `echo \${x-$((echo a); ${g})}`],
  ["a heredoc body", (g) => `cat <<E\n$((echo a); ${g})\nE`],
];
const GUARDED: Array<[string, string]> = [
  ["a push", PUSH],
  ["a merge", MERGE],
];
const SUBSHELL_CASES = SUBSHELLS.flatMap(([form, line]) => GUARDED.map(([name, guarded]): [string, string, string] => [name, form, line(guarded)]));

describe("a $(( that bash reads as a subshell in a command substitution", () => {
  it.each(SUBSHELL_CASES)("the hook denies %s in %s", async (_name, _form, command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it.each(SUBSHELL_CASES)("the built hook denies %s in %s", (_name, _form, command) => {
    expect(builtHookStdout(command)).toContain('"permissionDecision":"deny"');
  });

  it("reads the subshell's commands as a substitution", () => {
    const [, word] = tokenize("echo $((echo a); ls) END");
    expect(word?.type === "word" && word.subs.length).toBe(1);
  });
});

describe("a heredoc in a $( ) inside ${…}, which bash 3.2 ends at the first )", () => {
  const command = (guarded: string) => `echo \${x-$(cat <<E\n)}\n${guarded}\nE\n)}`;

  it.each(GUARDED)("the hook denies %s on the line after it", async (_name, guarded) => {
    expect(await hookDenies(command(guarded))).toBe(true);
  });

  it.each(GUARDED)("the built hook denies %s on the line after it", (_name, guarded) => {
    expect(builtHookStdout(command(guarded))).toContain('"permissionDecision":"deny"');
  });

  it("the hook names the substitution bash 3.2 ends elsewhere", async () => {
    const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
    const result = await handle(event(command("ls")), { PATH: "/usr/bin" }, port);
    expect(result.stdout).toContain("move the command substitution out of the expansion");
  });
});

describe("subshell-shaped $(( nested deep", () => {
  it("lexes without running out of its reading budget", () => {
    let nested = ": a";
    for (let i = 0; i < 100; i++) nested = `echo $((${nested}) )`;
    expect(tokenize(`${nested}\n${PUSH}`).length).toBeGreaterThan(0);
  });
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { tokenize } from "./lexer.js";
import { ParseError } from "./parse-error.js";

const HOME = "/home/you";
const PUSH = "git push origin HEAD:feat";

const port: HookPort = {
  context: nodeContext(HOME, { realpath: (p) => p, readHead: () => "feat", isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

const input = (command: string) => JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });

async function handled(command: string): Promise<"deny" | "pass"> {
  const { stdout } = await handle(input(command), {}, port);
  return stdout === "" ? "pass" : "deny";
}

const REFUSED = [
  ["a protected map subscript", ": ${options[globsubst]::=on}"],
  ["a prefix assignment value", "x=${options[globsubst]::=on} true"],
  ["a redirect target", ": > ${options[globsubst]::=on}"],
  ["a here-string", ": <<< ${(P)n::=on}"],
  ["a nested indirect name", ": ${(P)${n}::=on}"],
  ["a nested indirect name with a plain assign", "echo ${(P)${n}=on}"],
  ["a double-quoted indirect name", ': "${(P)n:=on}"'],
  ["a bash indirect name", ": ${!n:=x}"],
  ["an unquoted heredoc body", ": <<EOF\n${PS4:=x}\nEOF"],
  ["arithmetic", "echo $(( ${commands[y]::=1} ))"],
  ["a command substitution", ": $(: ${functions[y]::=x})"],
  ["a backtick substitution", ": `: ${functions[y]::=x}`"],
  ["a quoted prefix before the expansion", ': ""${(P)n::=x}'],
  ["a join inside the flag group", ": ${(P\\\n)n::=x}"],
  ["a join inside the protected name", ": ${opt\\\nions[globsubst]::=on}"],
  ["a join between the dollar and the brace", ": $\\\n{(P)n::=x}"],
  ["a subscript computed at run time", ": ${options[$k]::=on}"],
  ["a flag group with an argument", ": ${(j:,:P)n::=x}"],
  ["a zsh prefix before the name", ": ${=options[globsubst]::=on}"],
  ["a plain assign operator", ": ${options[globsubst]=on}"],
  ["an assigning expansion inside a default", ": ${y:-${(P)n::=x}}"],
  ["an assignment inside a double-quoted default", ': "${y:-${options[globsubst]::=on}}"'],
  ["a hooked name", ": ${module_path::=x}"],
  ["a rebinding name", ": ${nameddirs[x]::=/y}"],
  ["HOME, which selects a child shell's startup files", ": ${HOME:=/tmp}"],
  ["a positional indirect name", "set -- PS4; : ${!1:=x}"],
  ["a multi-digit positional indirect name", ": ${!10:=x}"],
  ["a zsh positional indirect name", ": ${(P)1::=x}"],
  ["a zsh indirect name of all arguments", ": ${(P)@::=x}"],
  ["an indirect special parameter", ": ${!#=x}"],
  ["an indirect name that is text", ": ${! x:=y}"],
  ["a brace splice past the read window", `: {$,}{${",".repeat(700)}}{PS4:=x}`],
  ["a brace splice with a long head", `: {$,${"a".repeat(700)}}{PS4:=x}`],
  ["a pad flag width writing functions", ": ${(l:functions[ls]=1:)x}"],
  ["a pad flag width writing aliases", ": ${(r:aliases[ls]=1:)x}"],
  ["an index flag writing options", ": ${(I:options[globsubst]=1:)x#a}"],
  ["an alias table element", ": ${aliases[ls]::=git}"],
  ["a global alias table element", ": ${galiases[ls]::=git}"],
  ["a suffix alias table element", ": ${saliases[ls]::=git}"],
  ["a bash alias table element", ": ${BASH_ALIASES[ls]=git}"],
] as const;

/** Text the lexer reads as a quoted word; the command walk lexes it again where `eval` or `-c` runs it. */
const REFUSED_IN_RUN_TEXT = [
  ["eval text", "eval ': ${options[globsubst]::=on}'"],
  ["eval text holding a nested indirect name", `eval ': \${(P)\${n}::=on}'`],
  ["bash -c text", "bash -c ': ${PS4:=x}'"],
  ["eval text with a command substitution", "eval ': $(: ${commands[y]::=1})'"],
] as const;

const PASSED = [
  ["an unprotected name", ": ${WGETRC:=x}"],
  ["an unprotected default assigned", ": ${TMPDIR:=/tmp}"],
  ["a default that reads", "echo ${x:-$y}"],
  ["a single-quoted expansion", "git commit -m '${PS4:=x}'"],
  ["a quoted heredoc body", ": <<'EOF'\n${PS4:=x}\nEOF"],
  ["an indirect read", "echo ${(P)n}"],
  ["an indirect read with a default", "echo ${(P)n:-x}"],
  ["a protected read", "echo ${options[globsubst]} ${PS4:-x} ${commands[ls]}"],
  ["a longer name that starts like a protected one", ": ${optionsx::=1} ${PS44:=x}"],
  ["a flag argument holding a P", ": ${(j:P:)x}"],
  ["a quoted P", "echo '${(P)n::=x}'"],
  ["a positional indirect read", "echo ${!1} ${(P)1} ${(P)@:-x} ${!#}"],
  ["a pad flag width that only reads", ": ${(l:width:)x} ${(l:5:)x}"],
  ["a literal dollar and comma far from any brace", `echo '$,' ${"a".repeat(700)}`],
] as const;

describe("an assigning expansion with an indirect, nested or protected target is refused by the lexer (TP-3172)", () => {
  it.each(REFUSED)("throws ParseError for %s", (_form, line) => {
    expect(() => tokenize(`${line}; ${PUSH}`)).toThrow(ParseError);
  });

  it.each(REFUSED)("denies %s through handle()", async (_form, line) => {
    expect(await handled(`${line}; ${PUSH}`)).toBe("deny");
  });

  it.each(REFUSED_IN_RUN_TEXT)("denies %s through handle()", async (_form, line) => {
    expect(await handled(`${line}; ${PUSH}`)).toBe("deny");
  });

  it.each(PASSED)("allows %s", async (_form, line) => {
    expect(await handled(`${line}; ${PUSH}`)).toBe("pass");
  });

  it("refuses a target hidden past the longest window it reads", () => {
    expect(() => tokenize(`: \${(P)n[${"a".repeat(900)}]::=x}`)).toThrow(ParseError);
  });
});

const zsh = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe.skipIf(!zsh)("zsh really turns GLOB_SUBST on through the refused forms (TP-3172)", () => {
  function globsubstAfter(script: string): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assign-expand-"));
    try {
      const result = spawnSync("zsh", ["-f", "-c", `${script}; [[ -o globsubst ]] && print on`], { cwd: dir, encoding: "utf8", input: "" });
      return result.stdout.includes("on");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    ["a bare subscript", ": ${options[globsubst]::=on}"],
    ["a prefix assignment value", "x=${options[globsubst]::=on} true"],
    ["a redirect target", ": > ${options[globsubst]::=on}"],
    ["a here-string", 'n="options[globsubst]"; : <<< ${(P)n::=on}'],
    ["a nested indirect name", 'n="options[globsubst]"; : ${(P)${n}::=on}'],
  ])("%s", (_form, script) => {
    expect(globsubstAfter(script)).toBe(true);
  });

  it("leaves it off for an unprotected default", () => {
    expect(globsubstAfter(": ${WGETRC:=x}")).toBe(false);
  });
});

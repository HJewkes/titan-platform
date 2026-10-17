import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { assignedInMath, mentionedIn } from "./hooked-names.js";
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
  ["an assignment in $(( ))", ": $(( PS4=1 ))"],
  ["a compound assignment", ": $(( PS4 += 1 ))"],
  ["a pre-increment", ": $(( ++PS4 ))"],
  ["a post-increment of PATH", ": $(( PATH++ ))"],
  ["an assignment in $[ ]", ": $[ PS4=1 ]"],
  ["a subscript inside math", ": $(( a[PS4=1] ))"],
  ["an IFS assignment", ": $(( IFS=1 ))"],
  ["a ${a[ ]} subscript", ": ${a[PS4=7]}"],
  ["a bash offset", ": ${x:PS4=1}"],
  ["a bash length", ": ${x:0:PS4=1}"],
  ["a length-only form", ": ${x::PS4=1}"],
  ["a ${#a[ ]} subscript", ": ${#a[PS4=1]}"],
  ["a nested subscript", ": ${a[b[1]+PS4=1]}"],
  ["an offset past a nested expansion", ": ${x:${y}+PS4=1}"],
  ["a positional offset", ": ${1:PS4=1}"],
  ["math with a nested group", ": $(( (1) + (PS4=1) ))"],
  ["a double-quoted form", ': "$(( PS4=1 ))"'],
  ["an unquoted heredoc body", ": <<EOF\n$(( PS4=1 ))\nEOF"],
  ["a nested command substitution", ": $(: $(( BASH_ENV=1 )))"],
  ["a backslash-newline join", ": $\\\n(( PS4=1 ))"],
  ["a body that does not close in the window", `: $((${" ".repeat(600)}PS4=1 ))`],
  ["a nested group that does not close in the window", `: $(( (${" ".repeat(600)}PS4=1) ))`],
  ["a [ group that does not close in the window", `: $(( a[${" ".repeat(600)}PS4=1] ))`],
  ["a subscript that does not close in the window", `: \${a[${" ".repeat(600)}PS4=1]}`],
] as const;

const REFUSED_IN_RUN_TEXT = [["eval text", "eval ': $(( PS4=1 ))'"]] as const;

const PASSED = [
  ["plain math", "echo $(( x + 1 ))"],
  ["a comparison", "echo $(( PS4 == 1 ))"],
  ["a name that only starts like a hook", "echo $(( PATHX=1 ))"],
  ["a read in math", "echo $(( PS4 + 1 ))"],
  ["a subscript sum", "echo ${a[i+1]}"],
  ["a substring", "echo ${x:1:2}"],
  ["an offset that reads", "echo ${x:PS4}"],
  ["a default value", "echo ${x:-PS4=1}"],
  ["a subshell in a substitution", "echo $((echo hi); echo there)"],
  ["a quoted commit message", "git commit -m '$(( PS4=1 ))'"],
] as const;

describe("math that writes a protected parameter at a $ is refused by the lexer (TP-3294)", () => {
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
});

describe("the math readers take the set of names to look for (TP-3294)", () => {
  const names = new Set(["BASH_ENV"]);

  it("finds a write to a name in the given set only", () => {
    expect(assignedInMath("BASH_ENV=1", names)).toBe("BASH_ENV");
    expect(assignedInMath("PS4=1", names)).toBeNull();
  });

  it("keeps the hooked names as the default", () => {
    expect(assignedInMath("PS4=1")).toBe("PS4");
    expect(assignedInMath("BASH_ENV=1")).toBeNull();
  });

  it("finds a mention at or after an offset, as a whole identifier", () => {
    expect(mentionedIn("BASH_ENV x BASH_ENV", 1, names)).toBe("BASH_ENV");
    expect(mentionedIn("XBASH_ENV", 1, names)).toBeNull();
    expect(mentionedIn("MY_PS4 PS4")).toBe("PS4");
  });
});

const run = (shell: string, args: string[]): string => {
  const result = spawnSync(shell, args, { encoding: "utf8", input: "", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  return result.status === 0 ? result.stdout : "";
};
const bash = spawnSync("bash", ["--norc", "-c", "true"]).status === 0;
const zsh = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe.skipIf(!bash)("bash really sets PS4 through the refused forms (TP-3294)", () => {
  it.each([
    ["$(( PS4=1 ))", ': $(( PS4=1 )); echo "$PS4"'],
    ["${a[PS4=7]}", ': ${a[PS4=7]}; echo "$PS4"'],
    ["${x:PS4=1}", "x=abcdef; : ${x:PS4=1}; echo \"$PS4\""],
  ])("%s", (_form, script) => {
    expect(run("bash", ["--norc", "-c", script]).trim()).toMatch(/^[1-9]$/);
  });
});

describe.skipIf(!zsh)("zsh really sets PS4 through $[ ] (TP-3294)", () => {
  it("$[ PS4=1 ]", () => {
    expect(run("zsh", ["-f", "-c", ': $[ PS4=1 ]; echo "$PS4"']).trim()).toBe("1");
  });
});

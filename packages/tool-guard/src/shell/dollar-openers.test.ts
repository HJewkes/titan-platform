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
import { DOLLAR_OPENERS, dollarOpener, EXPANSION_OPENERS } from "./balanced.js";
import { SplitParseError, tokenize } from "./lexer.js";

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

async function hookStdout(command: string): Promise<string> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  return (await handle(event(command), { PATH: "/usr/bin" }, port)).stdout;
}

// CI builds before it tests; locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-dollar-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function builtHookStdout(command: string): string {
  const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input: event(command, home), env: { ...process.env, HOME: home }, encoding: "utf-8" });
  expect(run.status).toBe(0);
  return run.stdout;
}

const DENY = '"permissionDecision":"deny"';
/** A backslash-newline, which bash drops before it reads the word. */
const JOIN = "\\\n";

const GUARDED: Array<[string, string]> = [
  ["a push", PUSH],
  ["a merge", MERGE],
];

/** Joins between or after the two parens bash reads as one `$((` or `((`. */
const PAREN_JOINS: Array<[string, (guarded: string) => string]> = [
  ["a join between the parens of $((", (g) => `true || : $(${JOIN}( 1 #)); ${g}\n))`],
  ["joins after $ and between the parens of $((", (g) => `true || : $${JOIN}(${JOIN}( 1 #)); ${g}\n))`],
  ["a join between the parens of a top-level ((", (g) => `true || (${JOIN}( 1 #)); ${g}\n))`],
];

/** Each hides the guarded command after it from a reader that takes the opener for text. */
const HIDERS: Array<[string, (guarded: string) => string]> = [
  ["a # inside a top-level $[ ]", (g) => `true || : $[ #]; ${g}`],
  ["a # inside a double-quoted $[ ]", (g) => `true || : "$[ #]"; ${g}`],
  ["a substitution inside $[ ]", (g) => `echo $[ $(${g}) ]`],
  ["an unclosed $[", (g) => `: $[ 1 + ; ${g}`],
  ["a locale string as the subcommand", (g) => g.replace(/^(\S+) (\S+)/, '$1 $"$2"')],
  ["a joined $[ ]", (g) => `true || : $${JOIN}[ #]; ${g}`],
  ["a twice-joined $[ ]", (g) => `true || : $${JOIN}${JOIN}[ #]; ${g}`],
  ["a joined $[ ] inside double quotes", (g) => `true || : "$${JOIN}[ #]"; ${g}`],
  ["a joined $(( ))", (g) => `: $${JOIN}(( 1 #)); ${g}`],
  ["a joined $( ) in a heredoc body", (g) => `cat <<EOF\n$${JOIN}(${g})\nEOF`],
  ["a joined locale string as the subcommand", (g) => g.replace(/^(\S+) (\S+)/, `$1 $${JOIN}"$2"`)],
  ["a joined ANSI-C string as the subcommand", (g) => g.replace(/^(\S+) (\S+)/, `$1 $${JOIN}'$2'`)],
  ["a joined variable as the subcommand", (g) => g.replace(/^(\S+) (\S+)/, `ab=$2; a=x; $1 $${JOIN}ab`)],
  ["a variable name joined in the middle", (g) => g.replace(/^(\S+) (\S+)/, `ab=$2; a=x; $1 $a${JOIN}b`)],
  ...PAREN_JOINS,
  ["a joined heredoc delimiter", (g) => `cat <<EOF\nEO${JOIN}F\n${g}\nEOF`],
  ["a subscript assignment joined before its =", (g) => `Y[ 0 ]${JOIN}=x ${g}`],
  ["a joined $( ) inside a spaced subscript", (g) => `Y[ $${JOIN}(echo 0) ]=x ${g}`],
];

/** The rows whose `$[` a reader without a `[` entry must refuse. */
const BRACKET_HIDERS = HIDERS.filter(([name]) => name.includes("$[ ]"));

describe("a guarded command next to a $-opener", () => {
  it.each(GUARDED.flatMap(([name, g]) => HIDERS.map(([hider, line]) => [name, hider, line(g)] as const)))("the hook denies %s after %s", async (_name, _hider, command) => {
    expect(await hookStdout(command)).toContain(DENY);
  });

  it.each(GUARDED)("the built hook denies %s after a # inside a top-level $[ ]", (_name, guarded) => {
    expect(builtHookStdout(`true || : $[ #]; ${guarded}`)).toContain(DENY);
  });

  it.each(GUARDED)("the built hook denies %s after a joined $[ ]", (_name, guarded) => {
    expect(builtHookStdout(`true || : $${JOIN}[ #]; ${guarded}`)).toContain(DENY);
  });

  it.each(GUARDED.flatMap(([name, g]) => PAREN_JOINS.map(([join, line]) => [name, join, line(g)] as const)))("the built hook denies %s after %s", (_name, _join, command) => {
    expect(builtHookStdout(command)).toContain(DENY);
  });

  it("names the unclosed expansion when $[ never closes", async () => {
    expect(await hookStdout(`: $[ 1 + ; ${PUSH}`)).toContain("`$[ ]`");
  });
});

describe("a harmless $-opener", () => {
  it.each([
    ["a top-level $[ ]", "echo $[1+2] done"],
    ["a double-quoted $[ ]", 'echo "total $[a+b]"'],
    ["a literal $ before %", "printf '%s' \"$%\""],
    ["a lone $", "echo $ done"],
    ["a $' inside double quotes", `echo "cost $'5"`],
    ['a $" inside double quotes', 'echo "cost $"'],
    ["a joined top-level $[ ]", `echo $${JOIN}[1+2] done`],
    ["a joined $' inside double quotes", `echo "cost $${JOIN}'5"`],
    ["a joined literal $", `echo $${JOIN}% done`],
  ])("the hook passes %s", async (_name, command) => {
    expect(await hookStdout(command)).toBe("");
  });

  it("the built hook passes a top-level $[ ]", () => {
    expect(builtHookStdout("echo $[1+2] done")).toBe("");
  });
});

describe("where the lexer ends a $-opener", () => {
  it("reads a # inside $[ ] as part of the word, not a comment", () => {
    const words = tokenize("echo $[ #]; x").map((t) => (t.type === "word" || t.type === "op" ? t.value : t.type));
    expect(words).toEqual(["echo", "$[ #]", ";", "x"]);
  });

  it("reads a $[ ] joined by backslash-newlines as one word", () => {
    const words = tokenize(`echo $${JOIN}${JOIN}[ #]; x`).map((t) => (t.type === "word" || t.type === "op" ? t.value : t.type));
    expect(words).toEqual(["echo", "$[ #]", ";", "x"]);
  });

  it.each([
    ["&&", `a &${JOIN}& b`],
    ["<<", `cat <${JOIN}<EOF\nx\nEOF`],
  ])("joins the operator %s across a backslash-newline", (op, command) => {
    expect(tokenize(command).some((t) => (t.type === "op" || t.type === "redirect") && (t.type === "op" ? t.value : t.op) === op)).toBe(true);
  });

  it("keeps a quoted heredoc's backslash-newline, so its delimiter does not join", () => {
    const redirect = tokenize(`cat <<'EOF'\nEO${JOIN}F\nEOF`).find((t) => t.type === "redirect");
    expect(redirect?.type === "redirect" && redirect.body).toBe(`EO\\\nF\n`);
  });

  it("joins a variable name across a backslash-newline", () => {
    const [, word] = tokenize(`echo $a${JOIN}b`);
    expect(word?.type === "word" && word.refs.map((r) => r.name)).toEqual(["ab"]);
  });

  it("collects a substitution inside $[ ]", () => {
    const [, word] = tokenize("echo $[ $(true) ]");
    expect(word?.type === "word" && word.subs).toHaveLength(1);
  });

  it("reads a locale string as run-time text", () => {
    const [, word] = tokenize('git $"push"');
    expect(word?.type === "word" && word).toMatchObject({ value: "push", dynamic: true });
  });
});

describe("the shared $-opener table", () => {
  it.each(["$", "{", "[", "(", "'", '"'])("lists %s", (next) => {
    expect(Object.hasOwn(DOLLAR_OPENERS, next)).toBe(true);
  });

  it("lists every expansion opener", () => {
    expect([...EXPANSION_OPENERS].filter((next) => !Object.hasOwn(DOLLAR_OPENERS, next))).toEqual([]);
  });

  it("refuses an expansion opener the table does not list, so each $[ hider still denies", async () => {
    const table = DOLLAR_OPENERS as Record<string, unknown>;
    const saved = table["["];
    delete table["["];
    try {
      expect(() => dollarOpener("$[1]", 0)).toThrow(SplitParseError);
      for (const [, line] of BRACKET_HIDERS) for (const [, guarded] of GUARDED) expect(await hookStdout(line(guarded))).toContain(DENY);
    } finally {
      table["["] = saved;
    }
  });

  it.each([["a name", "$x"], ["a special parameter", "$?"], ["text", "$%"], ["the end of the line", "$"]])("reads %s after $ as no opener", (_name, src) => {
    expect(dollarOpener(src, 0)).toBeNull();
  });
});

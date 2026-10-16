import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ClassifyContext } from "../types.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import { ParseError, tokenize } from "./lexer.js";

const REPO = "/home/you/projects/app";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};

const PUSH = "git push origin HEAD:main";
const probe = (form: string) => `${form}\n${PUSH}\nE`;

// Bash rejects each `(` as a syntax error and registers no heredoc, so the lines after it are no heredoc body.
const REJECTED = [
  "echo ( x <<E )",
  "echo (x <<E)",
  "echo a ( <<E )",
  "echo $x ( <<E )",
  'echo "a" ( <<E )',
  "echo if ( <<E )",
  "echo function f ( <<E )",
  "then ( <<E )",
  "else ( <<E )",
  "do ( <<E )",
  "declare ( <<E )",
  ">f ( <<E )",
  "a=1 ( <<E )",
  "(x) ( <<E )",
  "{ x; } ( <<E )",
  "if x; then :; fi ( <<E )",
  "f ( x <<E )",
  "f (\n) <<E",
  "f ( )\n<<E",
  "echo ( ) <<E",
  "echo ( ) x <<E",
  "echo $(echo ( x <<E\n))",
].map(probe);

// With extglob on, bash reads `<<E` in each as pattern text, registers no heredoc, and runs the push.
const EXTGLOB = [
  ...["echo @(x <<E)", "echo x !( <<E )", "@(x <<E)", "echo x@(x <<E)", "echo *( <<E )", "echo +( <<E )", "echo ?( <<E )"].map(
    (form) => probe(`shopt -s extglob\n${form}`),
  ),
  probe("!(cat <<E)"),
];

const LEGAL = [
  "( cat <<E\nhi\nE\n)",
  "x; (y)",
  "x && (y)",
  "x | (y)",
  "x |& (y)",
  "x & (y)",
  "if (x); then :; fi",
  "if x; then (y); elif z; then (w); else (v); fi",
  "while (x); do (y); done",
  "for a in b; do (y); done",
  "! (x)",
  "{ (x); }",
  "time (x)",
  "time -p (x)",
  "time -p -- (x)",
  "time ! (x)",
  "coproc (x)",
  "coproc foo (x)",
  "f ( ) { :; }",
  "f () ( :; )",
  "f() (x)",
  "f() { (x); }",
  "f (\t) { :; }",
  "f \\\n( ) { :; }",
  "f ( \\\n) { :; }",
  "f ( )\n{ :; }",
  "function f ( ) { :; }",
  "function f ( x )",
  "function f ( cat <<E\nhi\nE\n)",
  "echo ( ) { :; }",
  "f() { cat <<E\nbody\nE\n}",
  "case a in (a) :;; esac",
  "case a in a) :;; (b) :;; esac",
  "case a in a) :;& (b) :;; esac",
  "case x in a) (y);; esac",
  "case a in\n(a) :;;\nesac",
  "[[ ( a == b ) ]]",
  "[[ a && ( b ) ]]",
  "[[ ! ( a ) ]]",
  "[[ x == @(a|b) ]]",
  "for ((i=0;i<1;i++)); do :; done",
  "((1))",
  "echo <(x) >(y)",
  "a=( $(cat <<E\nhi\nE\n) )\necho ok",
  "echo $( (x) )",
  "echo $(cat <<E\nhi\nE\n)",
];

async function hookDenies(command: string): Promise<boolean> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const result = await handle(input, { PATH: "/usr/bin" }, port);
  return result.stdout !== "";
}

describe("a ( bash rejects or may read as an extglob pattern", () => {
  it.each([...REJECTED, ...EXTGLOB])("the hook denies the push after %j", async (command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it.each([...REJECTED, ...EXTGLOB])("the lexer refuses %j", (command) => {
    expect(() => tokenize(command)).toThrow(ParseError);
  });
});

describe("a ( where bash opens a subshell, header, body or pattern", () => {
  it.each(LEGAL)("the lexer reads %j", (command) => {
    expect(() => tokenize(command)).not.toThrow();
  });

  it.each(LEGAL)("the hook allows %j", async (command) => {
    expect(await hookDenies(command)).toBe(false);
  });
});

const bashOnPath = spawnSync("bash", ["-c", "true"]).status === 0;

describe.skipIf(!bashOnPath)("bash on each ( position", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tool-guard-tp-2600-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const bashN = (command: string, ...flags: string[]) =>
    spawnSync("bash", [...flags, "-n", "-c", command], { cwd: scratch, encoding: "utf-8", timeout: 5000 });

  it.each(REJECTED)("bash -n rejects %j as a syntax error", (command) => {
    const run = bashN(command);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/syntax error/);
  });

  it.each(["echo @(x <<E)", "echo x@(x <<E)", "@(x <<E)"].map(probe))("bash -O extglob -n reads %j as pattern text", (command) => {
    expect(bashN(command, "-O", "extglob").status).toBe(0);
  });

  it.each(LEGAL)("bash -n accepts %j", (command) => {
    expect(bashN(command).status).toBe(0);
  });
});

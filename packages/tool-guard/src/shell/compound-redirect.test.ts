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

// Bash rejects each line as a syntax error, registers no heredoc, and so runs the push after it.
const FORMS = [
  "a=( x <<E )",
  "a+=( x <<E )",
  "declare -a a=( x <<E )",
  "declare -A a=( [k]=v <<E )",
  "f() { local a=( x <<E ); }; f",
  "typeset -a a=( x <<E )",
  "a=(\nx <<E\n)",
  "a=( x <<-E )",
  "a= ( x <<E )",
  "a=x ( x <<E )",
  "a=( x <<<y )",
  "a=( x >f )",
];

// Any operator but `)` ends the line in a syntax error too; each probe hides the push from a guard that reads on.
const OPERATOR_PROBES = [
  `a=( x ; ) <<E\n${PUSH}\nE`,
  `a=( x || y ) 'q\n${PUSH}\n'`,
  `a=( x | y ) 'q\n${PUSH}\n'`,
  `a=( x |& y ) 'q\n${PUSH}\n'`,
  `a=( x && y ) 'q\n${PUSH}\n'`,
  `a=( x & ) <<E\n${PUSH}\nE`,
  `a=( x ;; ) <<E\n${PUSH}\nE`,
  `declare -a a=( x ; ) 'q\n${PUSH}\n'`,
  `a=( x\n; ) '\n${PUSH}\n'`,
  `a=( x ; ) $(cat <<E\n${PUSH}\nE\n)`,
  `a=( (x) ) <<E\n${PUSH}\nE`,
  `a=( ((1)) ) <<E\n${PUSH}\nE`,
];

// Where `NAME=(` only groups, any exemption must end with that context, and `echo =~` or `echo [[` opens none.
const CONTEXT_EXIT_PROBES = [
  `((1)); a=( x ; ) <<E\n${PUSH}\nE`,
  `[[ x =~ a=(b) ]]; a=( x ; ) <<E\n${PUSH}\nE`,
  `[[ x =~ a=(b) ]] && a=( x ; ) <<E\n${PUSH}\nE`,
  `[[ x =~ y ]]\na=( x ; ) <<E\n${PUSH}\nE`,
  `echo =~ a=( x ; ) <<E\n${PUSH}\nE`,
  `echo [[ x =~ a=( x ; ) <<E\n${PUSH}\nE`,
  `echo [[ ] ] =~ a=( x ; ) <<E\n${PUSH}\nE`,
  `[[ x ; y =~ a=( x ; ) <<E\n${PUSH}\nE`,
];

// Bash reads a redirect inside a `=~` operand's parens as regex text and runs the next line; a `]]` there ends
// the loose `[` span early, so only the operand check sees the `<<`.
const REGEX_TEXT_PROBES = [
  `[[ x =~ (<<E) ]]\n${PUSH}\nE`,
  `[[ x =~ a=(<<E) ]]\n${PUSH}\nE`,
  `[[ x =~ (]]<<E) ]]\n${PUSH}\nE`,
  `[[ x =~ (a]]<<E) ]]\n${PUSH}\nE`,
  `[[ x =~ a=(]]<<E) ]]\n${PUSH}\nE`,
];

const probe = (form: string) => `${form}\n${PUSH}\nE`;
const PROBES = [...FORMS.map(probe), ...OPERATOR_PROBES, ...CONTEXT_EXIT_PROBES];

async function hookDenies(command: string): Promise<boolean> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const result = await handle(input, { PATH: "/usr/bin" }, port);
  return result.stdout !== "";
}

describe("a redirect or operator inside a compound assignment", () => {
  it.each(PROBES)("the hook denies the push bash runs after %j", async (command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it.each([...PROBES, ...REGEX_TEXT_PROBES])("the lexer refuses %j", (command) => {
    expect(() => tokenize(command)).toThrow(ParseError);
  });

  it.each(REGEX_TEXT_PROBES)("the hook denies the push bash runs after the regex text in %j", async (command) => {
    expect(await hookDenies(command)).toBe(true);
  });
});

const BENIGN = [
  "a=( <(echo hi) )",
  "a=( $(cat <<E\nhi\nE\n) )\necho ok",
  "a=(x y); cat <<E\nbody\nE",
  "if (cat <<E\nhi\nE\n); then :; fi",
  "( cat <<E\nhi\nE\n)",
  "x=1; (cat <<E\nhi\nE\n)",
  "a=( x # c ; ( |\n y )\necho ok",
  "a=( $((1)) x )",
  "a=(x) <<E\nbody\nE",
];

// `NAME=(` in arithmetic or a `=~` operand is a parenthesised group bash accepts.
const GROUPED = [
  "((a=(1|2)))",
  "for ((i=(0|1); i<2; i++)); do :; done",
  "[[ a=b =~ a=(b|c) ]]",
  "((x=(y<z)))",
  "((a=(1), b=(2&3)))",
  "x=$((a=(1|2)))",
  "if ((a=(1|2))); then :; fi",
  "[[ x =~ a=(b;c) ]]",
  "[[ x =~ a=(b|c)d=(e) ]]",
  "[[ x =~ (a=(b)) ]]",
  "[[ ( x =~ a=(b) ) ]]",
  "if [[ x =~ a=(b) ]]; then :; fi",
  "! [[ x =~ a=(b) ]] && [[ y =~ c=(d|e) ]]",
  "echo x | [[ x =~ a=(b|c) ]]",
  "[[ x =~ y && z =~ a=(b|c) ]]",
];

describe("a heredoc or process substitution bash accepts around an array", () => {
  it.each(BENIGN)("the lexer reads %j", (command) => {
    expect(() => tokenize(command)).not.toThrow();
  });

  it.each(BENIGN)("the hook allows %j", async (command) => {
    expect(await hookDenies(command)).toBe(false);
  });
});

describe("NAME=( where bash reads it as a group", () => {
  it.each(GROUPED)("the lexer reads %j", (command) => {
    expect(() => tokenize(command)).not.toThrow();
  });

  it.each(GROUPED)("the hook allows %j", async (command) => {
    expect(await hookDenies(command)).toBe(false);
  });
});

const bashOnPath = spawnSync("bash", ["-c", "true"]).status === 0;

describe.skipIf(!bashOnPath)("bash on each compound redirect probe", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tool-guard-tp-2573-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it.each(PROBES)("bash -n rejects %j as a syntax error", (command) => {
    const run = spawnSync("bash", ["-n", "-c", command], { cwd: scratch, encoding: "utf-8", timeout: 5000 });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/syntax error near (unexpected token )?`/);
  });

  it.each(GROUPED)("bash -n accepts %j", (command) => {
    const run = spawnSync("bash", ["-n", "-c", command], { cwd: scratch, encoding: "utf-8", timeout: 5000 });

    expect(run.status).toBe(0);
  });
});

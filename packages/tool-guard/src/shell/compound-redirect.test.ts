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

const probe = (form: string) => `${form}\n${PUSH}\nE`;

async function hookDenies(command: string): Promise<boolean> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const result = await handle(input, { PATH: "/usr/bin" }, port);
  return result.stdout !== "";
}

describe("a redirect inside a compound assignment", () => {
  it.each(FORMS)("the hook denies a push bash runs after a redirect in %j", async (form) => {
    expect(await hookDenies(probe(form))).toBe(true);
  });

  it.each(FORMS)("the lexer refuses %j", (form) => {
    expect(() => tokenize(probe(form))).toThrow(ParseError);
  });

  it("the hook denies a push after a subshell bash rejects inside an array", async () => {
    expect(await hookDenies(`a=( (x) )\n${PUSH}`)).toBe(true);
  });
});

const BENIGN = [
  "a=( <(echo hi) )",
  "a=( $(cat <<E\nhi\nE\n) )\necho ok",
  "a=(x y); cat <<E\nbody\nE",
  "if (cat <<E\nhi\nE\n); then :; fi",
  "( cat <<E\nhi\nE\n)",
  "x=1; (cat <<E\nhi\nE\n)",
];

describe("a heredoc or process substitution bash accepts around an array", () => {
  it.each(BENIGN)("the lexer reads %j", (command) => {
    expect(() => tokenize(command)).not.toThrow();
  });

  it.each(BENIGN)("the hook allows %j", async (command) => {
    expect(await hookDenies(command)).toBe(false);
  });
});

const bashOnPath = spawnSync("bash", ["-c", "true"]).status === 0;

describe.skipIf(!bashOnPath)("bash on each compound redirect probe", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tool-guard-tp-2573-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it.each(FORMS)("bash -n rejects %j as a syntax error", (form) => {
    const run = spawnSync("bash", ["-n", "-c", probe(form)], { cwd: scratch, encoding: "utf-8", timeout: 5000 });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("syntax error near unexpected token");
  });
});

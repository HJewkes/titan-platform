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

// Bash reads extglob inside `[[ ]]` with no shopt, so each heredoc opener is pattern text and `bash -c` runs the push.
const PATTERN_TEXT = [
  probe("[[ x == @(]]<<E) ]]"),
  probe("[[ x == !(a]]<<E) ]]"),
  probe("[[ x == @(a <<E) ]]"),
  probe("[[ x == ?(]]<<-E) ]]"),
  `[[ x == *(a]] <<<y) ]]\n'q\n${PUSH}\n'`,
  probe("if [[ x == @(]]<<E) ]]; then :; fi"),
];

const ALLOWED = [
  "[[ a < b ]]",
  "[[ ( a < b ) ]]",
  "[[ a > b ]]",
  "[[ $((1<<2)) -eq 4 ]]",
  "[[ $(cat <<E\nx\nE\n) ]]",
  "[[ x ]] && cat <<E\nbody\nE",
  "[[ x == @(a|b) ]]",
];

async function hookDenies(command: string): Promise<boolean> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const result = await handle(input, { PATH: "/usr/bin" }, port);
  return result.stdout !== "";
}

describe("a heredoc opener inside [[ ]]", () => {
  it.each(PATTERN_TEXT)("the hook denies the push after %j", async (command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it.each(PATTERN_TEXT)("the lexer refuses %j", (command) => {
    expect(() => tokenize(command)).toThrow(ParseError);
  });
});

describe("a comparison or closed conditional beside a heredoc", () => {
  it.each(ALLOWED)("the lexer reads %j", (command) => {
    expect(() => tokenize(command)).not.toThrow();
  });

  it.each(ALLOWED)("the hook allows %j", async (command) => {
    expect(await hookDenies(command)).toBe(false);
  });
});

const bashOnPath = spawnSync("bash", ["-c", "true"]).status === 0;

describe.skipIf(!bashOnPath)("bash on a heredoc opener inside [[ ]]", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tool-guard-tp-2600-b-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const bashN = (command: string) => spawnSync("bash", ["-n", "-c", command], { cwd: scratch, encoding: "utf-8", timeout: 5000 });

  it.each(PATTERN_TEXT)("bash -n accepts %j, reading the opener as pattern text", (command) => {
    expect(bashN(command).status).toBe(0);
  });

  it.each(ALLOWED)("bash -n accepts %j", (command) => {
    expect(bashN(command).status).toBe(0);
  });
});

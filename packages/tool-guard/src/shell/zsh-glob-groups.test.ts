import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  readHead: (dir) => (dir === REPO ? "feat" : null),
  readScript: () => null,
};

const PUSH = "git push origin HEAD:main";

// zsh reads each group as a glob qualifier, case flag, alternation or extglob, none of which the bash lexer models.
const ZSH_GROUPS = [
  `ls *(e:'true':); ${PUSH}`,
  `ls a(#i)b; ${PUSH}`,
  `ls (a|b); ${PUSH}`,
  `echo x@(main); ${PUSH}`,
  "git push origin ma*(N)",
  `[[ x == (<<E) ]]\n${PUSH}\nE`,
];

const SUBSTITUTION_IN_GROUP = `[[ $y == (a|$(${PUSH})) ]]`;

async function hookDenies(command: string): Promise<boolean> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const result = await handle(input, { PATH: "/usr/bin" }, port);
  return result.stdout !== "";
}

describe("a zsh glob qualifier, alternation or extglob group", () => {
  it.each(ZSH_GROUPS)("the lexer refuses %j", (command) => {
    expect(() => tokenize(command)).toThrow(ParseError);
  });

  it.each(ZSH_GROUPS)("the hook denies %j", async (command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it("keeps a substitution inside a [[ ]] alternation in subs, so the hook denies its push", async () => {
    const subs = tokenize(SUBSTITUTION_IN_GROUP).flatMap((token) => (token.type === "word" ? token.subs : []));
    const subTexts = subs.map((sub) => sub.map((token) => (token.type === "word" ? token.value : "")).join(" "));

    expect(subTexts).toContain(PUSH);
    expect(await hookDenies(SUBSTITUTION_IN_GROUP)).toBe(true);
  });

  it("allows a plain push to the current feature branch, so each deny above comes from the group", async () => {
    expect(await hookDenies("git push origin HEAD:feat")).toBe(false);
  });
});

const zshOnPath = spawnSync("zsh", ["-f", "-c", "true"]).status === 0;

describe.skipIf(!zshOnPath)("zsh on each group form", () => {
  const scratch = mkdtempSync(join(tmpdir(), "tool-guard-tp-2839-b-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const zsh = (...args: string[]) => spawnSync("zsh", ["-f", ...args], { cwd: scratch, encoding: "utf-8", timeout: 5000 });

  it.each(ZSH_GROUPS.slice(0, -1))("zsh -n accepts %j, so the push after the group would run", (command) => {
    expect(zsh("-n", "-c", command).status).toBe(0);
  });

  it("zsh -n rejects the heredoc opener inside a [[ ]] group", () => {
    const run = zsh("-n", "-c", ZSH_GROUPS.at(-1) ?? "");

    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/parse error/);
  });

  it("an (e::) qualifier inside [[ ]] runs nothing, because [[ ]] matches patterns without generating filenames", () => {
    zsh("-c", "[[ x == *(e:'touch pwn':) ]]");

    expect(existsSync(join(scratch, "pwn"))).toBe(false);
  });
});

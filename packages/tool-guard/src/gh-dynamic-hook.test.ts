import { describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const REPO = `${HOME}/app`;
const HEAD_FILE = `${REPO}/.git/HEAD`;

const port: HookPort = {
  context: nodeContext(HOME, { realpath: (p) => p, readHead: () => "ref: refs/heads/feat/x\n", isFile: (p) => p === HEAD_FILE }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

const input = (command: string) => JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });

async function handled(command: string): Promise<"deny" | "pass"> {
  const { stdout } = await handle(input(command), {}, port);
  return stdout === "" ? "pass" : "deny";
}

describe("a gh command whose group or verb is only known at run time, on a feature branch", () => {
  it.each([
    ["gh $X"],
    ['gh "$X"'],
    ["gh pr $X"],
    ["gh pr $X 5"],
    ["gh pr merge$X 5"],
    ["gh $X merge 5"],
    ["gh release $X v1"],
    ["gh gist $X f"],
    ["gh -R o/r $X"],
    ["gh $(cat f) merge 1"],
    ["gh $X 5 && git push"],
  ])("denies %s", async (command) => {
    expect(await handled(command)).toBe("deny");
  });

  it.each([
    ["gh pr view 1"],
    ["gh pr view $N"],
    ['gh --repo "$R" pr view 1'],
    ["gh run view $ID"],
    ["gh api repos/o/r/pulls/$N"],
    ['gh pr create --title "$T"'],
    ["gh pr view 1 && git push"],
  ])("passes %s", async (command) => {
    expect(await handled(command)).toBe("pass");
  });
});

describe("a dynamic command word read as gh", () => {
  it("denies a run-time verb after a literal group", async () => {
    expect(await handled('"$G" pr $X 5')).toBe("deny");
  });

  it.each([['"$EDITOR" file'], ['"$PM" start 3000'], ['"$G" push']])("passes %s, whose literal words gh would read as an alias", async (command) => {
    expect(await handled(command)).toBe("pass");
  });
});

import { describe, expect, it } from "vitest";
import type { ReadFs } from "../context.js";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import type { HookPort } from "../hook.js";
import { handle } from "../hook.js";

const HOME = "/home/you";
const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};
const port: HookPort = { context: nodeContext(HOME, noFs), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function decisionOf(command: string): Promise<string | null> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
  const { stdout } = await handle(input, {}, port);
  if (stdout === "") return null;
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout;
}

describe("a subscript bash may join but the guard splits", () => {
  it.each([
    ["after ((", "declare -A a; ((1)); a[ # ]=x; git push origin HEAD:main"],
    ["after [[ ]]", "declare -A a; [[ 1 ]]; a[ # ]=x; git push origin HEAD:main"],
    ["after case … esac", "declare -A a; case 1 in 1) :;; esac; a[ # ]=x; git push origin HEAD:main"],
    ["inside a case clause", "case 1 in 1) a[ # ]=x; git push origin HEAD:main;; esac"],
    ["in a += form", "((1)); a[ # ]+=x; git push origin HEAD:main"],
    ["with the push on the next line", "((1)); a[ # ]=x\ngit push origin HEAD:main"],
    ["holding a heredoc opener", "((1)); a[ <<E ]=x\ngit push origin HEAD:main\nE"],
    ["placeable with no = after the ]", "x[ # ]; git push origin HEAD:main"],
    ["ahead of gh pr merge", "((1)); a[ # ]=x; gh pr merge 1"],
  ])("denies a push hidden behind # %s", async (_scenario, command) => {
    expect(await decisionOf(command)).toBe("deny");
  });

  it.each([
    ["arithmetic then a plain subscript", "((i++)); a[$i]=x; echo ok"],
    ["a test then a subscript", "[[ -n $x ]] && a[0]=y"],
    ["a real comment after a command", "((1)); echo hi # git push origin HEAD:main"],
    ["a comment in a subscript bash splits as an argument", "echo a[ # git push origin HEAD:main ]"],
  ])("passes %s", async (_scenario, command) => {
    expect(await decisionOf(command)).toBeNull();
  });
});

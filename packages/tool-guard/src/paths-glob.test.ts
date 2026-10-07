import { describe, expect, it } from "vitest";
import { classify } from "./classify.js";
import { nodeContext } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";
import { matchGlob } from "./paths.js";
import type { GuardedList } from "./paths.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

const WORDS = ["[]*+]", "[]]", "[!]*+]", "[a-]", "[z-a]", "[\\\\]", "[[", "[^]", "[abc"];
const line = (word: string) => `git push origin HEAD:main; cat '${word}'`;

const port: HookPort = {
  context: nodeContext(HOME, { realpath: (p) => p, readHead: () => "feat/x", isFile: () => false }),
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  loadDecide: async () => decide,
};

function event(command: string) {
  return { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: "s", toolUseId: "t" };
}

describe("a command word the glob compiler once could not compile", () => {
  it.each(WORDS)("still classifies the push to main in %s", (word) => {
    const ctx = { home: HOME, readLink: () => null, readHead: () => "feat/x", readScript: () => null };

    const spellings = classify(event(line(word)), ctx).map((a) => a.spelling);

    expect(spellings).toContain("bash.merge.git-push-protected");
  });

  it.each(WORDS)("denies the line at the hook for %s", async (word) => {
    const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command: line(word) } });

    const { stdout } = await handle(input, {}, port);

    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("glob compilation", () => {
  const list = { paths: [{ id: "x", pattern: "/home/you/*" }] } as unknown as GuardedList;

  it("reads a leading ] as a member of the class", () => {
    expect(matchGlob("/home/you/[]*+]", list, HOME)?.id).toBe("x");
  });

  it("compiles every string up to length 4 over the hostile alphabet", () => {
    const alphabet = [..."[]!^*+?-\\a/"];
    const one = { paths: [{ id: "p", pattern: "/a" }] } as unknown as GuardedList;
    const threw: string[] = [];
    let level = [""];
    for (let n = 0; n < 4; n++) {
      level = level.flatMap((s) => alphabet.map((c) => s + c));
      for (const s of level) {
        try {
          matchGlob(s, one, HOME);
        } catch {
          threw.push(s);
        }
      }
    }
    expect(threw).toEqual([]);
  });
});

describe("ordinary globs keep their meaning", () => {
  const match = (glob: string, path: string) =>
    matchGlob(glob, { paths: [{ id: "p", pattern: path }] } as unknown as GuardedList, HOME) !== null;

  it.each([
    ["/a/[abc]", "/a/b", true],
    ["/a/[abc]", "/a/d", false],
    ["/a/[!abc]", "/a/d", true],
    ["/a/[!abc]", "/a/a", false],
    ["/a/[^abc]", "/a/d", true],
    ["/a/[a-c]", "/a/b", true],
    ["/a/[a-c]", "/a/d", false],
    ["/a/*.ts", "/a/x.ts", true],
    ["/a/*.ts", "/a/x/y.ts", false],
    ["/a/**/x", "/a/b/c/x", true],
    ["/a/**/x", "/a/x", true],
    ["/a/[]]", "/a/]", true],
    ["/a/[a-]", "/a/-", true],
    ["/a/[abc", "/a/[abc", true],
  ])("%s against %s is %s", (glob, path, expected) => {
    expect(match(glob, path)).toBe(expected);
  });
});

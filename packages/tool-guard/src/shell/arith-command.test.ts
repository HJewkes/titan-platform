import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";
import { extractCommands } from "./commands.js";

const names = (src: string) => extractCommands(src).map((c) => c.name);
const pushes = (src: string) => extractCommands(src).filter((c) => c.name === "git" && c.args.some((a) => a.value === "push")).length;

describe("an arithmetic command runs no command named by its words", () => {
  it.each(["((a[1<<2]))", "(( a[ 1 << 2 ] ))", "(( arr[1] ))", "((1))", "if ((x)); then :; fi"])("%s", (src) => {
    const found = names(src).filter((n) => n !== ":");
    expect(found).toEqual([]);
  });
});

describe("a substitution inside an arithmetic command is still walked", () => {
  it.each(["(( $(git push) ))", "((a[$(git push)]))", "(( `git push` ))"])("%s reports git push", (src) => {
    expect(pushes(src)).toBe(1);
  });
});

describe("a span that reads as a command stays a nested subshell", () => {
  it.each([
    "( (git push) )",
    "((git push) )",
    "((git push))",
    "(((git push)))",
    "(( (git push) ))",
    "((\ngit push\n))",
    "((git -C dir push))",
  ])("%j reports git push", (src) => {
    expect(pushes(src)).toBeGreaterThan(0);
  });

  it.each([
    "((a=1;git push))",
    "((git;push))",
    "((git=1 push))",
    "((${x} push))",
    "(($x push))",
    "((x && git push))",
    "((x\ngit push))",
    "((git -- push))",
    "((/usr/bin/git push))",
  ])("%j still reports a command", (src) => {
    expect(extractCommands(src).length).toBeGreaterThan(0);
  });

  it("keeps for ((;;)) as it was", () => {
    expect(names("for ((;;)); do git push; done")).toContain("git");
  });
});

describe("what follows an arithmetic command is still walked", () => {
  it.each([
    "if ((x)); then git push; fi",
    "while ((x)); do git push; done",
    "((x=1)) && git push",
    "((x=1)) | git push",
    "((1 # c\n))\ngit push",
    "((1\\\n+1))\ngit push",
    "((cat <<E\nx\nE\n))\ngit push",
  ])("%j reports git push", (src) => {
    expect(pushes(src)).toBeGreaterThan(0);
  });
});

describe("a probe that bash reads as arithmetic or as a refused line hides nothing", () => {
  it("reports the command of ((a));((b only as the lexer refuses or reads it", () => {
    let seen: (string | null)[] | "refused";
    try {
      seen = names("((a));((b");
    } catch {
      seen = "refused";
    }
    expect(seen === "refused" || !seen.includes("git")).toBe(true);
  });
});

describe("an arithmetic-looking span that main denies is still denied", () => {
  const REPO = "/home/you/projects/app";
  const context: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: (dir) => (dir === REPO ? "feat/x" : null), readScript: () => null };

  it("denies a protected push behind ((a=1;git push origin HEAD:main))", () => {
    const event = { kind: "bash" as const, command: "((a=1;git push origin HEAD:main))", cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
    expect(classify(event, context).map((a) => a.spelling)).toContain("bash.merge.git-push-protected");
  });
});

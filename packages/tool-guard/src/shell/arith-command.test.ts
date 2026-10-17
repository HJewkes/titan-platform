import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";
import { extractCommands } from "./commands.js";

// The Bash tool's own line runs in bash or zsh; a caller that does not say so gets the nested-subshell reading.
const bash = (src: string) => extractCommands(src, { arithmetic: true });
const names = (src: string) => bash(src).map((c) => c.name);
const reported = (src: string) => bash(src).map((c) => [c.name ?? "", ...c.args.map((a) => a.value)].join(" "));
const pushes = (src: string) => bash(src).filter((c) => c.name === "git" && c.args.some((a) => a.value === "push")).length;

describe("a caller that does not name the shell", () => {
  it("reads (( )) as nested subshells and lists the commands inside", () => {
    expect(extractCommands("((./push.sh))").map((c) => c.name)).toEqual(["push.sh"]);
  });
});

describe("a nested shell's text keeps the nested-subshell reading even on the bash line", () => {
  it.each(["sh -c '((./push.sh))'", "bash -c '((./push.sh))'", "eval '((./push.sh))'", "echo '((./push.sh))' | bash", "bash <<<'((./push.sh))'", "echo $(sh -c '((./push.sh))')"])("%s", (src) => {
    expect(names(src)).toContain("push.sh");
  });
});

describe("a (( split by a backslash-newline keeps the nested-subshell reading, as zsh runs it", () => {
  it.each(["(\\\n(./push.sh))", "((x));(\\\n(./push.sh))", "if (\\\n(./push.sh)); then :; fi"])("%j", (src) => {
    expect(names(src)).toContain("push.sh");
  });
});

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
    ["((a=1;git push))", ["git push"]],
    ["((git;push))", ["git", "push"]],
    ["((git=1 push))", ["push"]],
    ["((${x} push))", [" ${x} push", "push"]],
    ["(($x push))", [" $x push", "push"]],
    ["((x && git push))", ["x", "git push"]],
    ["((x\ngit push))", ["x", "git push"]],
    ["((git -- push))", ["git -- push"]],
    ["((git -- -- push))", ["git -- -- push"]],
    ["((/usr/bin/git push))", ["git push"]],
    ["((npm >f publish))", ["npm publish"]],
    ["((pnpm 2>&1 publish))", ["pnpm publish"]],
    ["((git >f push))", ["git push"]],
    ["((curl >f https://x))", ["curl https://x"]],
  ])("%j still reports the commands main reports", (src, expected) => {
    expect(reported(src)).toEqual(expected);
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

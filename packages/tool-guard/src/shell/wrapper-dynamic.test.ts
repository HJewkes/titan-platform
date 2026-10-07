import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";
import { extractCommands } from "./commands.js";
import { ParseError } from "./lexer.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

const verdicts = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => [a.spelling, a.subject]);
const spellings = (command: string) => verdicts(command).map(([s]) => s);

const PROTECTED_PUSH = "bash.merge.git-push-protected";
const MAIN_PUSH = [PROTECTED_PUSH, { branch: "main" }];

describe("xargs with no pipe into it", () => {
  it.each([
    ["a dynamic word among a wrapper's options", "xargs timeout $O 5 git push origin HEAD:main"],
    ["a dynamic replace string in the refspec", "xargs -I $R git push origin $R"],
    ["a replace string in the refspec", "xargs -I % git push origin %"],
  ])("reads a push as protected: %s", (_how, command) => {
    expect(spellings(command)).toContain(PROTECTED_PUSH);
  });
});

describe("a dynamic word a wrapper reads as its positional", () => {
  it.each([
    ["typed directly", "timeout $O 5 git push origin HEAD:main"],
    ["under xargs with piped input", "printf 'x\\n' | xargs timeout $O 5 git push origin HEAD:main"],
  ])("may be an option, so the command after it still runs: %s", (_how, command) => {
    expect(verdicts(command)).toContainEqual(MAIN_PUSH);
  });

  it("passes a push to an unprotected branch", () => {
    expect(verdicts("timeout $O 5 git push origin feat/y")).toEqual([]);
  });
});

describe("a dynamic command word behind a wrapper", () => {
  it.each([
    ["sudo", "sudo $G push origin HEAD:main"],
    ["timeout, quoted", "timeout 5 \"$G\" push origin HEAD:main"],
  ])("reads it as a direct dynamic word is read: %s", (_how, command) => {
    expect(verdicts(command)).toContainEqual(MAIN_PUSH);
  });

  it("keeps the piped input of an xargs after it", () => {
    expect(verdicts("printf 'HEAD:main\\n' | sudo $a xargs -I % git push origin %")).toContainEqual(MAIN_PUSH);
  });

  it("reads that piped input exactly, so a push to an unprotected branch passes", () => {
    expect(verdicts("printf 'HEAD:feat/y\\n' | sudo $a xargs -I % git push origin %")).toEqual([]);
  });
});

describe("dynamic words behind several wrappers", () => {
  const shapes = [
    ["two timeouts", "timeout $O 5 timeout $P 5"],
    ["sudo then timeout", "sudo $a timeout $O 5"],
    ["sudo, timeout and nice", "sudo $a timeout $O 5 nice -n $N"],
  ];
  const guarded = [
    ["git push", "git push origin HEAD:main", MAIN_PUSH],
    ["npm publish", "npm publish", ["bash.release.npm-publish", { tool: "npm" }]],
    ["gh pr merge", "gh pr merge 5", ["bash.merge.gh-pr-merge", { pr: "5" }]],
  ] as const;

  it.each(shapes.flatMap(([how, prefix]) => guarded.map(([what, tail, verdict]) => [`${what} after ${how}`, `${prefix} ${tail}`, verdict])))(
    "reads every wrapper's dynamic word as possibly absent: %s",
    (_how, command, verdict) => {
      expect(verdicts(command as string)).toContainEqual(verdict);
    },
  );

  it("passes a push to an unprotected branch", () => {
    expect(verdicts("timeout $O 5 timeout $P 5 git push origin feat/y")).toEqual([]);
  });
});

describe("a chain of dynamic wrapper words too long to read", () => {
  const tails = ["git push origin HEAD:main", "npm publish", "pnpm publish", "gh pr merge 5"];
  const deep = [
    ...[9, 10].map((n) => [`${n} x timeout $O 5`, Array(n).fill("timeout $O 5").join(" ")]),
    ...["sudo", "env", "nohup", "stdbuf", "command", "exec"].flatMap((w) => [9, 10].map((n) => [`${n} x ${w} $a`, Array(n).fill(`${w} $a`).join(" ")])),
  ];

  it.each(deep.flatMap(([how, prefix]) => tails.map((tail) => [`${tail} after ${how}`, `${prefix} ${tail}`])))(
    "fails as nesting too deep does, never open: %s",
    (_how, command) => {
      expect(() => verdicts(command as string)).toThrow(ParseError);
    },
  );

  it("still reads a chain at the depth limit", () => {
    expect(verdicts(`${Array(8).fill("timeout $O 5").join(" ")} git push origin HEAD:main`)).toContainEqual(MAIN_PUSH);
  });

  it("fails rather than reading a padded line once per dynamic word", () => {
    expect(() => verdicts(`${Array(1000).fill("sudo $a").join(" ")} git push origin HEAD:main`)).toThrow(ParseError);
  });
});

describe("a script that every reading of a dynamic wrapper runs", () => {
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const nested = (levels: number, inner: string) => Array.from({ length: levels }).reduce<string>((text) => `flock $F sh -c ${quote(text)}`, inner);

  it("is walked once per level, not once per reading", () => {
    const pushes = Array(20).fill("git push origin HEAD:main").join("; ");

    const commands = extractCommands(nested(7, pushes), { cwd: REPO, home: "/home/you" });

    expect(commands.length).toBeLessThanOrEqual(2 * (7 + 20));
  });

  it("still reads the push inside it", () => {
    expect(verdicts(nested(3, "git push origin HEAD:main"))).toContainEqual(MAIN_PUSH);
  });
});

describe("a wrapper or xargs that runs nothing guarded", () => {
  it.each([
    ["xargs echo of a dynamic replace string", "xargs -I $R echo $R"],
    ["sudo of a dynamic word's status", "sudo $G status"],
    ["plain xargs echo", "xargs echo hi"],
    ["plain sudo", "sudo ls"],
  ])("gives no verdict: %s", (_how, command) => {
    expect(verdicts(command)).toEqual([]);
  });
});

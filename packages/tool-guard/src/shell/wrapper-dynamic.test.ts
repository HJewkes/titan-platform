import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";
import { extractCommands } from "./commands.js";
import { ReadingLimitError } from "./unsure-readings.js";

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

describe("a long chain of dynamic wrapper words", () => {
  const tails = [
    ["git push origin HEAD:main", MAIN_PUSH],
    ["npm publish", ["bash.release.npm-publish", { tool: "npm" }]],
    ["pnpm publish", ["bash.release.pnpm-publish", { tool: "pnpm" }]],
    ["gh pr merge 5", ["bash.merge.gh-pr-merge", { pr: "5" }]],
  ] as const;
  const deep = [
    ...[9, 10].map((n) => [`${n} x timeout $O 5`, Array(n).fill("timeout $O 5").join(" ")]),
    ...["sudo", "env", "nohup", "stdbuf", "command", "exec"].flatMap((w) => [9, 10].map((n) => [`${n} x ${w} $a`, Array(n).fill(`${w} $a`).join(" ")])),
  ];

  it.each(deep.flatMap(([how, prefix]) => tails.map(([tail, verdict]) => [`${tail} after ${how}`, `${prefix} ${tail}`, verdict])))(
    "still reads the command with every dynamic word dropped: %s",
    (_how, command, verdict) => {
      expect(verdicts(command as string)).toContainEqual(verdict);
    },
  );

  it("keeps the verdicts of the rest of the line", () => {
    expect(verdicts(`git push origin HEAD:main; ${Array(9).fill("timeout $T 5").join(" ")} true`)).toContainEqual(MAIN_PUSH);
  });

  it("keeps what the reading as written gives", () => {
    expect(spellings(`${Array(10).fill("sudo $a").join(" ")} git status`)).toContain("bash.egress.raw-socket");
  });

  it("reads a dynamic command word late in the chain as the command", () => {
    expect(verdicts(`${Array(9).fill("sudo $a").join(" ")} sudo $b push origin HEAD:main`)).toContainEqual(MAIN_PUSH);
  });

  it("refuses a padded line whose readings the budget cannot cover", () => {
    expect(() => verdicts(`${Array(1000).fill("sudo $a").join(" ")} git push origin HEAD:main`)).toThrow(ReadingLimitError);
  });
});

describe("a reading only a dynamic word's value slot gives", () => {
  const harmless = Array(150).fill("timeout $O 5 echo hi; ").join("");
  const pushes = [
    ["past nine wrappers", `${Array(9).fill("timeout $O 5").join(" ")} timeout $P git push origin HEAD:main`, MAIN_PUSH],
    ["of npm past nine wrappers", `${Array(9).fill("timeout $O 5").join(" ")} timeout $P npm publish`, ["bash.release.npm-publish", { tool: "npm" }]],
    ["after a long harmless prefix", `${harmless}timeout $O 5 timeout $P git push origin HEAD:main`, MAIN_PUSH],
    ["behind sudo after a long harmless prefix", `${harmless}sudo $a sudo $b timeout $O 5 timeout $P git push origin HEAD:main`, MAIN_PUSH],
    ["as a dynamic command word between two others", `${Array(9).fill("timeout $O 5").join(" ")} timeout $P $G push $x HEAD:main`, MAIN_PUSH],
  ] as const;

  it.each(pushes)("is still walked: %s", (_how, command, verdict) => {
    expect(verdicts(command)).toContainEqual(verdict);
  });

  it("is walked for a name only the credential families read differently", () => {
    expect(spellings("timeout $O ls cat ~/.ssh/id_rsa")).toContain("bash.secret.cat");
  });

  it("costs nothing when it runs nothing guarded, however long the line", () => {
    expect(verdicts(Array(300).fill("timeout $O 5 echo hi").join("; "))).toEqual([]);
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

describe("a line of more dynamic command words than the reading budget", () => {
  const PUSH = "; git push origin HEAD:main";
  const segments = (segment: string, count: number) => `${Array(count).fill(segment).join("; ")}${PUSH}`;
  const repeat = (unit: string, n: number) => Array(n).fill(unit).join(" ");
  const lines = [
    ["$b $c segments", segments(repeat("$b $c", 45), 30)],
    ["$b segments", segments(repeat("$b", 45), 60)],
    ["xargs sudo $b segments", segments(repeat("xargs sudo $b", 14), 40)],
  ] as const;

  it.each(lines)("is refused rather than read statement by statement: %s", (_how, line) => {
    expect(() => verdicts(line)).toThrow(ReadingLimitError);
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

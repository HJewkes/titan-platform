import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

const verdicts = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => [a.spelling, a.subject]);

const PUSH = "bash.merge.git-push-protected";
const spellings = (command: string) => verdicts(command).map(([s]) => s);

describe("a dynamic word in a wrapper's option position", () => {
  it.each([
    ["timeout, unquoted", "timeout $O 5 git push origin HEAD:main"],
    ["timeout, quoted", "timeout \"$O\" 5 git push origin HEAD:main"],
    ["timeout, substitution", "timeout $(echo -s) 5 git push origin HEAD:main"],
    ["sudo", "sudo $O git push origin HEAD:main"],
    ["nice, quoted", "nice \"$O\" git push origin HEAD:main"],
    ["env", "env $O git push origin HEAD:main"],
    ["a second dynamic word", "sudo $A $B git push origin HEAD:main"],
    ["after a static option", "sudo -n $O git push origin HEAD:main"],
    ["a dynamic option value", "timeout -s $S 5 git push origin HEAD:main"],
    ["a nested wrapper", "sudo $O timeout 5 git push origin HEAD:main"],
  ])("reads every placement and fails closed: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it("keeps the single exact reading of a tracked value", () => {
    expect(verdicts("O=--signal=KILL; timeout $O 5 git push origin HEAD:main")).toContainEqual([PUSH, { branch: "main" }]);
    expect(spellings("O=--signal=KILL; timeout $O 5 ls")).not.toContain(PUSH);
  });

  it.each([
    ["timeout $T ls"],
    ["sudo $O git status"],
    ["nice \"$O\" git status"],
    ["timeout $T 5 git log"],
  ])("does not flag a harmless command: %s", (command) => {
    expect(spellings(command)).not.toContain(PUSH);
  });
});

describe("a dynamic word in an xargs option position", () => {
  it.each([
    ["a cluster", "printf 'HEAD:main\\n' | xargs -0 -$O % git push origin %"],
    ["a quoted cluster", "printf 'HEAD:main\\n' | xargs -0 -\"$O\" % git push origin %"],
    ["a replace string", "printf 'HEAD:main\\n' | xargs -I $R git push origin $R"],
    ["a quoted replace string", "printf 'HEAD:main\\n' | xargs -I \"$R\" git push origin \"$R\""],
    ["a dynamic option word", "printf 'HEAD:main\\n' | xargs $O git push origin HEAD:main"],
  ])("gets a push verdict: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });
});

describe("a dynamic word after xargs", () => {
  it("keeps failing closed on a dynamic command word behind a wrapper", () => {
    expect(spellings("xargs env \"$G\" push origin HEAD:main")).toContain(PUSH);
  });
});

describe("a dynamic word past the wrapper's options", () => {
  it.each([
    ["three dynamic arguments", "sudo $O git push origin HEAD:main $A $B $C"],
    ["many dynamic arguments", "sudo $O git push origin HEAD:main $A $B $C $D $E $F"],
    ["many dynamic arguments, timeout", "timeout $O 5 git push origin HEAD:main $A $B $C $D $E"],
  ])("still reads the option position: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });
});

describe("more dynamic option words than the exact reading takes", () => {
  it.each([
    ["sudo", "sudo $A $B $C $D $E git push origin HEAD:main"],
    ["timeout", "timeout $A $B $C $D $E 5 git push origin HEAD:main"],
    ["sudo with a dynamic argument", "sudo $A $B $C $D $E git push origin HEAD:main $X"],
  ])("fails closed: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it("does not flag a harmless command", () => {
    expect(spellings("sudo $A $B $C $D $E git status")).not.toContain(PUSH);
  });
});

describe("a dynamic word's literal text in the readings", () => {
  it.each([
    ["the reviewer's substitution in single quotes", "sudo $O $X $P'$(echo ' git push origin HEAD:main -o$Q')'"],
    ["an unterminated substitution in single quotes", "sudo $O $P'$(' git push origin HEAD:main"],
    ["a parameter expansion in single quotes", "sudo $O $P'${' git push origin HEAD:main"],
    ["a backtick in single quotes", "sudo $O $P'`' git push origin HEAD:main"],
    ["a double quote in single quotes", "sudo $O $P'\"' git push origin HEAD:main"],
    ["a backslash in single quotes", "sudo $O $P'\\' git push origin HEAD:main"],
    ["a semicolon in single quotes", "sudo $O $P';' git push origin HEAD:main"],
    ["a single quote in double quotes", "sudo $O \"$P'\" git push origin HEAD:main"],
    ["a newline in single quotes", "sudo $O $P'\n' git push origin HEAD:main"],
    ["a substitution in a trailing word", "sudo $O git push origin HEAD:main $P'$('"],
    ["a literal word with a quote", "sudo $O git push origin HEAD:main 'a\"b'\\''c'"],
  ])("keeps it literal and still reads the push: %s", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it("does not flag a harmless command", () => {
    expect(spellings("sudo $O $P'$(' git status")).not.toContain(PUSH);
  });
});

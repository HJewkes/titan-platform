import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "feat/x" : null),
  readScript: () => null,
};

function verdicts(command: string): string[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, context).map((a) => `${a.spelling} ${JSON.stringify(a.subject)}`);
}

const PROTECTED_MAIN = 'bash.merge.git-push-protected {"branch":"main"}';

describe("shell text built from a value a case attribute may have changed (TP-1531)", () => {
  it.each([
    ["eval", "declare -l X; X='git PUSH origin HEAD:main'; eval \"$X\""],
    ["bash -c", "declare -l X; X='git PUSH origin HEAD:main'; bash -c \"$X\""],
    ["sh -c", "declare -l X; X='git PUSH origin HEAD:main'; sh -c \"$X\""],
    ["eval of an unquoted word", "declare -l X; X=PUSH; eval git $X origin HEAD:main"],
    ["a folded eval command word", "declare -l E; E=EVAL; $E 'git push origin HEAD:main'"],
  ])("reads the -l text folded under %s", (_, command) => {
    expect(verdicts(command)).toEqual([PROTECTED_MAIN]);
  });

  it.each([
    ["eval", "declare -u X; X='git push origin HEAD:main'; eval \"$X\""],
    ["bash -c", "declare -u X; X='git push origin HEAD:main'; bash -c \"$X\""],
    ["sh -c", "declare -u X; X='git push origin HEAD:main'; sh -c \"$X\""],
  ])("keeps main's as-written reading of the -u text under %s", (_, command) => {
    expect(verdicts(command)).toEqual([PROTECTED_MAIN]);
  });
});

describe("a command word a case attribute may have changed (TP-1531)", () => {
  it.each([
    ["-l", "declare -l G; G=GIT; $G push origin HEAD:main"],
    ["-l through a copy", "declare -l G; G=GIT; H=$G; $H push origin HEAD:main"],
    ["-l on a wrapper", "declare -l S; S=SUDO; $S git push origin HEAD:main"],
    ["-l on a wrapper and the command", "declare -l S G; S=SUDO; G=GIT; $S $G push origin HEAD:main"],
  ])("reads the name folded with %s", (_, command) => {
    expect(verdicts(command)).toEqual([PROTECTED_MAIN]);
  });

  it("keeps main's as-written reading of a -u name", () => {
    expect(verdicts("declare -u G; G=git; $G push origin HEAD:main")).toEqual([PROTECTED_MAIN]);
  });

  it.each([
    ["a -l name the case leaves alone", "declare -l G; G=echo; $G push"],
    ["an unmarked name", "G=GIT; $G push origin HEAD:main"],
    ["an unmarked eval text", "X='git PUSH origin HEAD:main'; eval \"$X\""],
  ])("finds nothing for %s", (_, command) => {
    expect(verdicts(command)).toEqual([]);
  });
});

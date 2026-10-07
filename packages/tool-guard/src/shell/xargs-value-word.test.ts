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

function spellings(command: string): string[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, context).map((a) => a.spelling);
}

const PUSH = ["bash.merge.git-push-protected"];

describe("a word an xargs option takes as its value is not an option of its own", () => {
  it.each([
    ["--max-args -0", "printf 'push origin HEAD:main' | xargs --max-args -0 git"],
    ["--max-procs -0", "printf 'push origin HEAD:main' | xargs --max-procs -0 git"],
    ["--max-chars -0", "printf 'push origin HEAD:main' | xargs --max-chars -0 git"],
    ["--arg-file -0", "printf 'push origin HEAD:main' | xargs --arg-file -0 git"],
    ["-E -n2", "printf 'push origin HEAD:main' | xargs -E -n2 git"],
    ["-s -n2", "printf 'push origin HEAD:main' | xargs -s -n2 git"],
    ["-P -n2", "printf 'push origin HEAD:main' | xargs -P -n2 git"],
    ["-J -n2", "printf 'push origin HEAD:main' | xargs -J -n2 git"],
    ["-J -0", "printf 'push origin HEAD:main' | xargs -J -0 git"],
    ["-n -0", "printf 'push origin HEAD:main' | xargs -n -0 git"],
  ])("denies a push whose words stay together under %s", (_how, command) => {
    expect(spellings(command)).toEqual(PUSH);
  });

  it.each([
    ["-0 as a real separator", "printf 'push\\0origin\\0HEAD:main' | xargs -0 git"],
    ["-d with its value", "printf 'push,origin,HEAD:main' | xargs -d, git"],
  ])("still denies a push under %s", (_how, command) => {
    expect(spellings(command)).toEqual(PUSH);
  });
});

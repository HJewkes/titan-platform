import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

const verdicts = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => [a.spelling, a.subject]);

const UNKNOWN_PUSH = ["bash.merge.git-push-protected", { branch: "unknown" }];

describe("xargs running a dynamic command word", () => {
  it.each([
    ["a quoted variable", "xargs \"$G\" push origin HEAD:main"],
    ["an unquoted variable", "xargs $G push origin HEAD:main"],
    ["a variable after a wrapper", "xargs env \"$G\" push origin HEAD:main"],
    ["a variable fed by stdin", "echo x | xargs \"$G\" push origin HEAD:main"],
    ["a command substitution", "xargs $(echo git) push origin HEAD:main"],
  ])("fails closed as a protected push: %s", (_how, command) => {
    expect(verdicts(command)).toContainEqual(UNKNOWN_PUSH);
  });

  it.each([
    ["xargs rm"],
    ["xargs -0 grep x"],
    ["git ls-files -z | xargs -0 rm"],
  ])("keeps a static command's verdict: %s", (command) => {
    expect(verdicts(command)).toEqual([]);
  });

  // Out of scope here: main also returns [] for a dynamic command word typed directly.
  it("leaves a direct dynamic command word as main reads it", () => {
    expect(verdicts("\"$G\" push origin HEAD:main")).toEqual([]);
  });
});

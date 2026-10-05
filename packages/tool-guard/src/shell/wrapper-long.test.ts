import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const PUSH = "bash.merge.git-push-protected";

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

describe("a wrapper's abbreviated long option", () => {
  it.each([
    ["timeout --signal", "timeout --sig KILL 5 git push origin HEAD:main"],
    ["timeout --kill-after", "timeout --kill 3 5 git push origin HEAD:main"],
    ["nice --adjustment", "nice --adj 5 git push origin HEAD:main"],
    ["env --unset", "env --uns HOME git push origin HEAD:main"],
    ["env --chdir", "env --chd /tmp git push origin HEAD:main"],
    ["stdbuf --output", "stdbuf --out 0 git push origin HEAD:main"],
    ["stdbuf --input", "stdbuf --inp L git push origin HEAD:main"],
    ["nohup --version spelled short", "nohup --vers git push origin HEAD:main"],
    ["sudo --user", "sudo --us root git push origin HEAD:main"],
    ["sudo --prompt", "sudo --pro x git push origin HEAD:main"],
    ["flock --wait", "flock --wa 5 lock git push origin HEAD:main"],
    ["watch --interval", "watch --int 5 git push origin HEAD:main"],
    ["watch --exec", "watch --ex git push origin HEAD:main"],
  ])("still reads %s as a push to main", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it.each([
    ["timeout", "timeout --v KILL 5 git push origin HEAD:main"],
    ["env", "env --ig HOME git push origin HEAD:main"],
    ["sudo", "sudo --h root git push origin HEAD:main"],
    ["flock", "flock --n 5 lock git push origin HEAD:main"],
    ["watch", "watch --e 5 git push origin HEAD:main"],
  ])("reads an ambiguous prefix both ways and fails closed: %s", (_wrapper, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it.each([
    ["a full long option with =", "timeout --signal=KILL 5 ls"],
    ["an abbreviated long option with =", "timeout --sig=KILL 5 ls"],
    ["a spelled-out option and its value", "timeout --signal KILL 5 ls"],
    ["an abbreviated nice option", "nice --adj 5 ls"],
    ["an abbreviated env option", "env --uns HOME ls"],
    ["an abbreviated stdbuf option", "stdbuf --out 0 ls"],
  ])("does not flag a harmless command with %s", (_how, command) => {
    expect(spellings(command)).not.toContain(PUSH);
  });

  it("keeps an xargs prefix spelled out", () => {
    expect(spellings("echo x | xargs --max-a 1 git push origin HEAD:main")).toContain(PUSH);
  });
});

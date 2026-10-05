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

describe("a wrapper's short option that takes a separate value", () => {
  it.each([
    ["sudo -R", "sudo -R / git push origin HEAD:main"],
    ["sudo -T", "sudo -T 5 git push origin HEAD:main"],
    ["sudo -a", "sudo -a bsdauth git push origin HEAD:main"],
    ["sudo -c", "sudo -c staff git push origin HEAD:main"],
    ["sudo in a cluster", "sudo -nR / git push origin HEAD:main"],
    ["GNU env -a", "env -a x git push origin HEAD:main"],
    ["BSD env -P", "env -P /usr/bin git push origin HEAD:main"],
    ["FreeBSD env -L", "env -L root git push origin HEAD:main"],
    ["FreeBSD env -U", "env -U root git push origin HEAD:main"],
    ["BSD xargs -J", "xargs -J % git push origin HEAD:main"],
    ["BSD xargs -R", "xargs -R 1 git push origin HEAD:main"],
    ["BSD xargs -S", "xargs -S 255 git push origin HEAD:main"],
    ["GNU time -o", "time -o out.txt git push origin HEAD:main"],
    ["GNU time -f", "time -f %e git push origin HEAD:main"],
    ["GNU time --output", "time --output out.txt git push origin HEAD:main"],
    ["GNU time --format", "time --format %e git push origin HEAD:main"],
    ["an abbreviated GNU time --output", "time --out out.txt git push origin HEAD:main"],
  ])("reads %s as a push to main", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it.each([
    ["sudo -R/", "sudo -R/ git push origin HEAD:main"],
    ["sudo -T5", "sudo -T5 git push origin HEAD:main"],
    ["env -ax", "env -ax git push origin HEAD:main"],
    ["env -P/usr/bin", "env -P/usr/bin git push origin HEAD:main"],
    ["time -oout.txt", "time -oout.txt git push origin HEAD:main"],
  ])("reads the attached value of %s the same way", (_how, command) => {
    expect(spellings(command)).toContain(PUSH);
  });

  it.each([
    ["sudo -n", "sudo -n git status"],
    ["sudo -E", "sudo -E git status"],
    ["sudo -R", "sudo -R / git status"],
    ["env -a", "env -a x git status"],
    ["time -o", "time -o out.txt git status"],
  ])("gives no push verdict for %s before a harmless command", (_how, command) => {
    expect(spellings(command)).not.toContain(PUSH);
  });
});

import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import { foldsCaseOn } from "../context.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";

const linux: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "feat/x" : null),
  readScript: () => null,
};
const darwin: ClassifyContext = { ...linux, foldCase: true };

function verdicts(command: string, ctx: ClassifyContext = darwin): string[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, ctx).map((a) => `${a.spelling} ${JSON.stringify(a.subject)}`);
}

const PROTECTED_MAIN = 'bash.merge.git-push-protected {"branch":"main"}';

const FOLDED_ROWS = [
  ["GIT push origin HEAD:main", "git push origin HEAD:main"],
  ["Git push origin HEAD:main", "git push origin HEAD:main"],
  ["/USR/BIN/GIT push origin HEAD:main", "/usr/bin/git push origin HEAD:main"],
  ["GH pr merge 5", "gh pr merge 5"],
  ["NPM publish", "npm publish"],
  ["PNPM publish", "pnpm publish"],
  ["ENV GIT push origin HEAD:main", "env git push origin HEAD:main"],
  ["SUDO Git push origin HEAD:main", "sudo git push origin HEAD:main"],
  ["env -i GIT push origin HEAD:main", "env -i git push origin HEAD:main"],
  ["find . -exec GIT push origin HEAD:main \\;", "find . -exec git push origin HEAD:main \\;"],
  ["bash -c 'GIT push origin HEAD:main'", "bash -c 'git push origin HEAD:main'"],
  ["BASH -c 'git push origin HEAD:main'", "bash -c 'git push origin HEAD:main'"],
  ["echo 'GIT push origin HEAD:main' | sh", "echo 'git push origin HEAD:main' | sh"],
  ["G=GIT; $G push origin HEAD:main", "G=git; $G push origin HEAD:main"],
];

describe("a command word a case-insensitive filesystem runs whatever its case (TP-1623)", () => {
  it.each(FOLDED_ROWS)("reads %s as the lower-case spelling", (command, lower) => {
    const expected = verdicts(lower, linux);
    expect(expected).not.toEqual([]);
    expect(verdicts(command)).toEqual(expected);
  });

  it.each(FOLDED_ROWS)("adds no verdict for %s on a case-sensitive filesystem", (command) => {
    expect(verdicts(command, linux)).toEqual([]);
  });

  it("decides by platform: darwin and Windows fold, Linux does not", () => {
    expect([foldsCaseOn("darwin"), foldsCaseOn("win32"), foldsCaseOn("linux")]).toEqual([true, true, false]);
  });
});

describe("words a fold leaves as written (TP-1623)", () => {
  it.each([
    ["an argument", "git PUSH origin HEAD:main"],
    ["an argument that names a command", "echo GIT push origin HEAD:main"],
    ["a quoted argument", "printf '%s' 'GIT push origin HEAD:main'"],
  ])("keeps %s as on main", (_, command) => {
    expect(verdicts(command)).toEqual(verdicts(command, linux));
  });

  it("keeps the directory a folded CD would change, as bash runs CD from PATH in a child", () => {
    const readHead = (dir: string) => (dir === REPO ? "main" : dir === "/elsewhere" ? "feat/x" : null);
    const command = "CD /elsewhere && git push";
    const asWritten = verdicts(command, { ...linux, readHead });
    expect(asWritten).not.toEqual([]);
    expect(verdicts(command, { ...darwin, readHead })).toEqual(asWritten);
  });

  it("keeps a variable a folded EXPORT would set, as bash matches the builtin exactly", () => {
    expect(verdicts("G=git; EXPORT G=echo; $G push origin HEAD:main")).toEqual([PROTECTED_MAIN]);
  });

  it("keeps TP-1531's reading of a declare -l name", () => {
    expect(verdicts("declare -l G; G=GIT; $G push origin HEAD:main")).toEqual([PROTECTED_MAIN]);
    expect(verdicts("declare -l G; G=echo; $G push")).toEqual([]);
  });
});

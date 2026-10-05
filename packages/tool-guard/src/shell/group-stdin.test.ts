import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

const spellings = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx).map((a) => a.spelling);

const PUSH = "bash.merge.git-push-protected";
const SHELLS = ["bash", "sh", "zsh"];

const forms = (print: string, shell: string): Array<[string, string]> => [
  ["a brace group", `{ ${print}; } | ${shell}`],
  ["a subshell", `( ${print} ) | ${shell}`],
  ["process substitution as stdin", `${shell} < <(${print})`],
];

const rows = (print: string) => SHELLS.flatMap((shell) => forms(print, shell).map(([how, src]) => [shell, how, src, `${print} | ${shell}`]));

describe("a script printed by a group, subshell or process substitution", () => {
  it.each(rows("printf 'git push origin HEAD:main'"))("%s reads the push from %s: %s", (_shell, _how, src) => {
    expect(spellings(src)).toContain(PUSH);
  });

  it.each(rows("printf 'git pu\\0sh origin HEAD:main\\n'"))("%s reads a NUL split push from %s as a plain pipe does: %s", (_shell, _how, src, plain) => {
    expect(spellings(src)).toContain(PUSH);
    expect(spellings(src)).toEqual(spellings(plain));
  });

  it.each(rows("printf 'git\\0xyz push origin HEAD:main\\n'"))("%s reads a NUL cut word in %s as a plain pipe does: %s", (_shell, _how, src, plain) => {
    expect(spellings(src)).toEqual(spellings(plain));
  });

  it("cuts the zsh word at NUL in every form", () => {
    for (const [, src] of forms("printf 'git\\0xyz push origin HEAD:main\\n'", "zsh")) expect(spellings(src)).toContain(PUSH);
  });
});

describe("the text a group prints", () => {
  it.each([
    ["joined across commands", "{ printf 'git pu'; printf 'sh origin HEAD:main'; } | bash"],
    ["from the last printer after an unknown command", "{ ls; echo 'git push origin HEAD:main'; } | bash"],
    ["through a nested group", "{ ( printf 'git push origin HEAD:main' ); } | bash"],
    ["through nested subshells", "( ( printf 'git push origin HEAD:main' ) ) | bash"],
    ["past a stderr redirect", "{ printf 'git push origin HEAD:main'; } 2>/dev/null | bash"],
    ["into a pipe with stderr", "( printf 'git push origin HEAD:main' ) |& bash"],
    ["from a joined process substitution", "bash < <(printf 'git pu'; printf 'sh origin HEAD:main')"],
  ])("is read %s", (_how, src) => {
    expect(spellings(src)).toContain(PUSH);
  });

  it.each([
    ["a harmless group", "{ printf 'git status'; } | bash"],
    ["a harmless subshell", "( echo hi ) | bash"],
    ["a harmless process substitution", "bash < <(echo hi)"],
    ["a group whose output goes to a file", "{ printf 'git push origin HEAD:main'; } >out.sh | bash"],
    ["a subshell whose output goes to a file", "( printf 'git push origin HEAD:main' ) >out.sh | bash"],
    ["a group closed before a list", "{ printf 'git push origin HEAD:main'; }; bash"],
    ["a printer piped on inside the group", "{ printf 'git push origin HEAD:main' | grep -v push; } | bash"],
    ["a process substitution read as a file argument", "cat < <(printf 'git push origin HEAD:main')"],
  ])("gives no verdict for %s", (_how, src) => {
    expect(spellings(src)).not.toContain(PUSH);
  });

  it("keeps main's reading when nothing in the group prints known text", () => {
    expect(spellings("{ cat script.sh; } | bash")).toEqual(spellings("cat script.sh | bash"));
  });
});

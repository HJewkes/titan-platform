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

const PUSH = "Y[ 0 ]=x git push origin HEAD:main";

describe("a spaced subscript assignment followed by an unplaceable form", () => {
  it.each([
    ["a comment holding ((", `${PUSH} # ((`],
    ["case", `${PUSH}\ncase a in a) :;; esac`],
    ["esac", `${PUSH} # esac`],
    ["[[", `${PUSH}; [[ 1 ]]`],
    ["]]", `${PUSH} # ]]`],
    ["((", `${PUSH}; (( 1 ))`],
    ["))", `${PUSH} # ))`],
    ["a here-doc", `${PUSH}; cat <<E\nx\nE`],
    ["an extglob opener", `${PUSH}; echo @(a|b)`],
  ])("still reads the push to main with %s after it", (_form, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["a here-string before the command word", "Y[ 0 ]=x <<<x git push origin HEAD:main"],
    ["a $(( )) in a later assignment", "Y[ 0 ]=x A=$((1)) git push origin HEAD:main"],
    ["a $(( )) inside the subscript", "Y[ $((0)) ]=x git push origin HEAD:main"],
    ["a $(( )) in a later subscript", "Y[ 0 ]=x B[ $((1)) ]=y git push origin HEAD:main"],
    ["(( in the assigned value", 'Y[ 0 ]="a (( b" git push origin HEAD:main'],
  ])("still reads the push to main with %s", (_form, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it("keeps literal test brackets unflagged", () => {
    expect(spellings("test [ 0 ] && echo ok # ((")).not.toContain("bash.merge.git-push-protected");
  });
});

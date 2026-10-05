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

describe("a subscript assignment with blanks inside the brackets", () => {
  it.each([
    ["a prefix to the push", "Y[ 0 ]=x git push origin HEAD:main"],
    ["an append prefix to the push", "Y[ 1 ]+=x git push origin HEAD:main"],
    ["an element write that renames the subcommand", "Y=status; Y[ 0 ]=push; git $Y origin HEAD:main"],
  ])("still reads %s as a push to main", (_how, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["then after an assignment", "A=1 then Y[ ;git push origin HEAD:main; ]=x"],
    ["if after an assignment", "A=1 if Y[ ;git push origin HEAD:main; ]=x"],
    ["time after an assignment", "A=1 time Y[ ;git push origin HEAD:main; ]=x"],
    ["{ after an assignment", "A=1 { Y[ ;git push origin HEAD:main; ]=x"],
    ["a redirect before the word", ">/dev/null Y[ ;git push origin HEAD:main; ]=x"],
    ["a $'..' string holding quotes", `Y[ $'\\'"' ]; git push origin HEAD:main; echo "]=x"`],
    ["time after a pipe", "true | time Y[ ;git push origin HEAD:main; ]=x"],
    ["time after time", "time time Y[ ;git push origin HEAD:main; ]=x"],
    ["time after !", "! time Y[ ;git push origin HEAD:main; ]=x"],
    ["a ( in a case pattern", "case Y[ in (Y[ ) git push origin HEAD:main; ( ]=x) ;; esac"],
    ["a ( in a case pattern closed by ]=x", "case Y[ in (Y[ ) git push origin HEAD:main; ]=x) ;; esac"],
    ["a case pattern after |", "case Y[ in x|Y[ ) git push origin HEAD:main; ]=x ;; esac"],
    ["a case pattern after a spaced |", "case Y[ in x | Y[ ) git push origin HEAD:main; ]=x ;; esac"],
    ["a case pattern after a newline", "case Y[ in\nY[ ) git push origin HEAD:main; ]=x ;; esac"],
    ["a case pattern after ;; and a newline", "case a in z) :;;\nY[ ) git push origin HEAD:main; ]=x ;; esac"],
    ["[[ ]] with &&", "[[ 1 && Y[ == [[ ]]; git push origin HEAD:main; echo ]=x"],
    ["[[ ]] with ||", "[[ 1 || Y[ == [[ ]]; git push origin HEAD:main; echo ]=x"],
    ["(( )) with ||", "(( 1 || Y[ 1 )); git push origin HEAD:main; (( ]=1 ))"],
    ["a here-doc body", "cat <<E\nY[ \nE\ngit push origin HEAD:main; ]=x"],
    ...["@", "!", "?", "*", "+"].map((op): [string, string] => [
      `an extglob ${op}( pattern`,
      `shopt -s extglob\necho ${op}(a|Y[ ); git push origin HEAD:main; ]=x`,
    ]),
  ])("does not hide a push behind brackets with %s", (_how, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["a $( ) holding ]", "Y[ $(echo ]) ]=x git push origin HEAD:main"],
    ["a backtick span holding ]", "Y[ `echo ]` ]=x git push origin HEAD:main"],
    ["a ${ } holding ]", "Y[ ${Z:-]} ]=x git push origin HEAD:main"],
    ["a nested $( $( ] ) )", "Y[ $( $( ] ) ) ]=x git push origin HEAD:main"],
    ["a $( ) holding a nested subscript", "Y[ $( A[ ) ]=1 ) ]=x git push origin HEAD:main"],
    ["a backtick span holding a nested subscript", "Y[ `A[ ) ]=1` ]=x git push origin HEAD:main"],
    ["a ${ } holding a $( ) with a nested subscript", "Y[ ${Z:-$( A[ ) ]=1 )} ]=x git push origin HEAD:main"],
  ])("does not hide a push behind a subscript holding %s", (_how, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["a reserved word that starts the command", "if true; then Y[ 0 ]=x git push origin HEAD:main; fi"],
    ["another assignment", "A=1 Y[ 0 ]=x git push origin HEAD:main"],
    ["time at the start of the command", "time Y[ 0 ]=x git push origin HEAD:main"],
    ["!", "! Y[ 0 ]=x git push origin HEAD:main"],
    ["{", "{ Y[ 0 ]=x git push origin HEAD:main; }"],
  ])("still runs the push after a spaced subscript following %s", (_how, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });
});

import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import { extractCommands } from "./commands.js";
import { ValueWalkError } from "./unsure-readings.js";
import type { ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "feat/x" : null),
  readScript: () => null,
};

const spellings = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, context).map((a) => a.spelling);

const PUSH = "git push origin HEAD:main";
const VALUE = `X='a[$(${PUSH})]'`;

describe("a command substitution in the subscript of an arithmetic value (TP-1624)", () => {
  it.each([
    ["a (( )) that reads the value", `${VALUE}; (( X ))`],
    ["a let that reads the value", `${VALUE}; let X`],
    ["an expansion that reads the value", `${VALUE}; echo $(( X ))`],
    ["a [[ -eq ]] that reads the value", `${VALUE}; [[ X -eq 0 ]]`],
    ["a value reached through another name", `${VALUE}; Z=X; (( Z ))`],
  ])("classifies the push for %s", (_, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["a backslash-escaped )", `X='a[$(echo \\); ${PUSH})]'; (( X ))`],
    ["a single-quoted )", `X="a[\\$(echo ')'; ${PUSH})]"; (( X ))`],
    ["a double-quoted )", `X='a[$(echo ")"; ${PUSH})]'; (( X ))`],
  ])("classifies the push behind %s in the value", (_, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["a (( )) that reads $X", `${VALUE}; (( $X ))`],
    ["an expansion that reads $X", `${VALUE}; echo $(( $X ))`],
    ["an expansion that reads the braced name", `${VALUE}; echo $(( \${X} + 1 ))`],
    ["a legacy $[ ] that reads the name", `${VALUE}; echo $[ X ]`],
    ["an array-subscript write", `${VALUE}; a[X]=1`],
    ["an array element read", `${VALUE}; echo \${a[X]}`],
    ["a substring offset", `${VALUE}; s=hello; echo \${s:X}`],
    ["a substring length", `${VALUE}; s=hello; echo \${s:0:X}`],
    ["a trailing declare -i", `${VALUE}; declare -i X`],
  ])("classifies the push for %s", (_, command) => {
    expect(spellings(command)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["a plain echo of the name", `${VALUE}; echo X`],
    ["a default expansion", `${VALUE}; s=hello; echo \${s:-X}`],
  ])("leaves a value the line never evaluates as arithmetic unchecked, for %s", (_, command) => {
    expect(spellings(command)).not.toContain("bash.merge.git-push-protected");
  });

  it("leaves a value with no bracket before its substitution to the lines that evaluate it", () => {
    expect(spellings(`X='$(${PUSH})'; echo X`)).not.toContain("bash.merge.git-push-protected");
  });

  it("keeps the verdict of the direct form", () => {
    expect(spellings(`(( a[$(${PUSH})] ))`)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["an unknown value", "read X; (( X ))"],
    ["a self-reference", "X='X'; (( X ))"],
    ["a cycle", "X='Y'; Y='X'; (( X ))"],
  ])("ends on %s without a hang", (_, command) => {
    expect(() => spellings(command)).not.toThrow();
  });
});

describe("a value arithmetic reads that cannot be walked to its end (TP-1624)", () => {
  const push = "git push origin HEAD:main";
  it.each([
    ["a push after an unlexable bash -c", `X='a[$(bash -c "echo \\""; ${push})]'; (( X ))`],
    ["a push on the first line of a script that then fails to lex", `X='a[$(bash -c "${push}\necho \\"")]'; (( X ))`],
    ["the same value read by let", `X='a[$(bash -c "echo \\""; ${push})]'; let X`],
    ["the same value read by a numeric [[ ]]", `X='a[$(bash -c "echo \\""; ${push})]'; [[ X -eq 1 ]]`],
    ["a push in a later value once the substitution budget is spent", `X='a[${"$(:)".repeat(1500)}]'; (( X )); Y='a[$(${push})]'; (( Y ))`],
    ["an unlexable value read a second time", `X='a[$(bash -c "echo \\"")]'; [[ -n $X ]]; (( X ))`],
  ])("refuses %s", (_, line) => {
    expect(() => extractCommands(line)).toThrow(ValueWalkError);
  });

  it("follows no chain of plain names, which holds no code to run", () => {
    expect(() => extractCommands(`${Array.from({ length: 40 }, (_, i) => `V${i}=V${i + 1}`).join("; ")}; (( V0 ))`)).not.toThrow();
  });

  it("drops an unlexable value that arithmetic only maybe reads", () => {
    expect(() => extractCommands(`msg="don't"; [[ -n $msg ]]`)).not.toThrow();
  });
});

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

const pushSubjects = (command: string) =>
  classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, context)
    .filter((a) => a.spelling === "bash.merge.git-push-protected")
    .map((a) => a.subject);

describe("arithmetic writes made through a value or $(( )) (TP-1538)", () => {
  it.each([
    ["a (( )) that reads a value holding a write", "Y=status; X=Y=1; (( X )); git $Y origin HEAD:main"],
    ["a let that reads a value holding a write", "Y=status; X=Y=1; let X; git $Y origin HEAD:main"],
    ["a value that reaches a write through another name", "Y=status; X=W; W=Y=1; (( X )); git $Y origin HEAD:main"],
    ["a (( )) that reads an unknown value", "Y=status; read X; (( X )); git $Y origin HEAD:main"],
    ["a let that reads an unknown value", "Y=status; read X; let X; git $Y origin HEAD:main"],
    ["an expansion that writes", "Y=status; : $(( Y=1 )); git $Y origin HEAD:main"],
    ["an expansion inside a longer word", "Y=status; echo a$(( Y++ ))b; git $Y origin HEAD:main"],
    ["an unspaced expansion that writes", "Y=status; : $((Y++)); git $Y origin HEAD:main"],
    ["an unspaced pre-increment", "Y=status; : $((++Y)); git $Y origin HEAD:main"],
    ["an unspaced expansion that reads a value holding a write", "Y=status; X=Y=1; echo $((X)); git $Y origin HEAD:main"],
    ["an unspaced sum that reads a value holding a write", "Y=status; X=Y=1; : $((1+X)); git $Y origin HEAD:main"],
    ["a prefix assignment that reads a value holding a write", "Y=status; X=Y=1; A=$(( X )) true; git $Y origin HEAD:main"],
    ["a prefix assignment that writes", "Y=status; A=$((Y=1)) true; git $Y origin HEAD:main"],
    ["an expansion that names a value by $", "Y=status; Z=Y=1; : $(( $Z )); git $Y origin HEAD:main"],
    ["an expansion with a $ reference inside a longer word", "Y=status; Z=Y=1; echo a$(( $Z ))b; git $Y origin HEAD:main"],
    ["an expansion that reads a value holding a write", "Y=status; X=Y=1; : $(( X )); git $Y origin HEAD:main"],
  ])("leaves the variable unknown after %s, so the push stays protected", (_, command) => {
    expect(pushSubjects(command)).toEqual([{ branch: "unknown" }]);
  });

  it.each([
    ["a (( )) that reads a value with no write", "Y=push; Z=3; (( Z )); git $Y origin HEAD:main"],
    ["a let that reads a value with no write", "Y=push; Z=3; let Z; git $Y origin HEAD:main"],
    ["an expansion that only reads", "Y=push; Z=3; : $(( Z + 1 )); git $Y origin HEAD:main"],
  ])("keeps the exact reading after %s", (_, command) => {
    expect(pushSubjects(command)).toEqual([{ branch: "main" }]);
  });
});

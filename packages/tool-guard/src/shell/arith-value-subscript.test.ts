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

  it("keeps the verdict of the direct form", () => {
    expect(spellings(`(( a[$(${PUSH})] ))`)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["an unknown value", "read X; (( X ))"],
    ["a self-reference", "X='X'; (( X ))"],
    ["a cycle", "X='Y'; Y='X'; (( X ))"],
    ["a chain past the hop cap", `${Array.from({ length: 40 }, (_, i) => `V${i}=V${i + 1}`).join("; ")}; (( V0 ))`],
  ])("ends on %s without a hang", (_, command) => {
    expect(() => spellings(command)).not.toThrow();
  });
});

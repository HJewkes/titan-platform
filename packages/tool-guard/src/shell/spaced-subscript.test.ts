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
});

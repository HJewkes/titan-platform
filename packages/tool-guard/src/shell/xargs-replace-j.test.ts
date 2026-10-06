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

const PUSH = ["bash.merge.git-push-protected"];

describe("BSD xargs -J puts every input item of a run at the insert argument", () => {
  it.each([
    ["-J %", "echo HEAD:main | xargs -J % git push origin %"],
    ["-J%", "echo HEAD:main | xargs -J% git push origin %"],
    ["-0J % at the end of a cluster", "printf 'HEAD:main' | xargs -0J % git push origin %"],
    ["-tJ%", "echo HEAD:main | xargs -tJ% git push origin %"],
    ["-J naming the subcommand", "echo push origin HEAD:main | xargs -J % git %"],
    ["every line at one argument", "printf 'origin\\nHEAD:main' | xargs -J % git push %"],
    ["the subcommand from the first line", "printf 'push\\norigin HEAD:main' | xargs -J % git %"],
    ["-0 records", "printf 'push\\0origin\\0HEAD:main' | xargs -0 -J % git %"],
    ["-d, records", "printf 'push,origin,HEAD:main' | xargs -d, -J % git %"],
    ["a later -n 3 batch", "printf 'status x y push origin HEAD:main' | xargs -n 3 -J % git %"],
    ["a later -L1 batch", "printf 'status\\npush origin HEAD:main' | xargs -L1 -J % git %"],
    ["-J after -I, the last one winning", "echo push origin HEAD:main | xargs -I{} -J % git %"],
    ["-I after -J, the last one winning", "printf 'status\\npush origin HEAD:main' | xargs -J % -I{} git {}"],
    ["no argument equal to the insert string", "echo HEAD:main | xargs -J % git push origin"],
  ])("denies a push whose target comes from stdin under %s", (_how, command) => {
    expect(spellings(command)).toEqual(PUSH);
  });

  it("keeps main's -I reading when -J follows it", () => {
    expect(spellings("echo push origin HEAD:main | xargs -I{} -J % git {}")).toEqual(PUSH);
  });

  it("denies a merge spliced in at the insert argument", () => {
    expect(spellings("echo pr merge 1 | xargs -J % gh %")).toEqual(["bash.merge.gh-pr-merge"]);
  });

  it("reads a secret in a -0 record spliced in as a shell's script", () => {
    expect(spellings("printf 'cat ~/.npmrc' | xargs -0J % sh -c %")).toContain("bash.secret.xargs");
  });

  it.each([
    ["a stdin file", "xargs -J % git push origin % < targets.txt"],
    ["a stdin file at the subcommand", "xargs -J % git % < cmds.txt"],
    ["a non-static -d value", "printf 'xXHEAD:main' | xargs -J % -d \"$D\" git push origin %"],
    ["a heredoc fed through cat", "cat <<EOF | xargs -J % git %\npush origin HEAD:main\nEOF"],
  ])("fails closed behind %s", (_how, command) => {
    expect(spellings(command)).toEqual(PUSH);
  });

  it("fails closed on a merge behind a stdin file", () => {
    expect(spellings("xargs -J % gh % < cmds.txt")).toEqual(["bash.merge.gh-pr-merge"]);
  });

  it.each([
    "echo status | xargs -J % git %",
    "printf 'a\\nb' | xargs -J % echo %",
    "xargs -J % git -C % status < repos.txt",
  ])("still allows %s", (command) => {
    expect(spellings(command)).toEqual([]);
  });
});

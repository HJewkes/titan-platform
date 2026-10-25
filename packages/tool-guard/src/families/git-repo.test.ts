import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

const fakeContext: ClassifyContext = { home: HOME, readLink: () => null, readHead: (dir) => (dir === REPO ? "feat/x" : null), readScript: () => null };

function run(command: string, ctx: ClassifyContext = fakeContext): ClassifiedAction[] {
  return classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx);
}

const unknown = (spelling: string) => [expect.objectContaining({ action: "merge", spelling, subject: { branch: "unknown" } })];

describe("a git command whose repository the line may relocate reads its head as unknown", () => {
  it.each([
    "GIT_DIR=/x/.git git push",
    "GIT_WORK_TREE=. git push",
    "GIT_COMMON_DIR=/x git push",
    "GIT_NAMESPACE=n git push",
    'GIT_DIR="$X" git push',
    "env GIT_WORK_TREE=. git push",
    "env GIT_D''IR=/x git push",
    "export GIT_DIR=x; git push",
    'export "GIT_DIR"=/x; git push',
    "declare -n r=GIT_DIR; r=/x; export r; git push",
    "set -a; read -r GIT_DIR < f; git push",
    "source env.sh && git push",
    "GIT_DIR=/x/.git git status; git push",
    ": ${GIT_DIR:=/x}; git push",
  ])("%s", (command) => {
    expect(run(command)).toEqual(unknown("bash.merge.git-push-implicit"));
  });

  it("a merge in a relocated repository may be into main", () => {
    expect(run("GIT_DIR=/x/.git git merge origin/x")).toEqual(unknown("bash.merge.git-merge-protected"));
  });

  it("a push of HEAD in a relocated repository may push main", () => {
    expect(run("GIT_DIR=/x/.git git push origin HEAD")).toEqual(unknown("bash.merge.git-push-protected"));
  });
});

describe("a git global option outside the repository-keeping list makes the repository unknown", () => {
  it.each(["git --bare push", "git --namespace=n push", "git --namespace n push", "git --exec-path=/x push", "git --super-prefix=x/ push"])("%s", (command) => {
    expect(run(command)).toEqual(unknown("bash.merge.git-push-implicit"));
  });
});

describe("settings that leave the repository where it is pass", () => {
  it.each([
    "GIT_TERMINAL_PROMPT=0 git push",
    "GIT_TRACE=1 GIT_TRACE_PACKET=1 git push origin feat/x",
    "GIT_AUTHOR_NAME=a GIT_COMMITTER_EMAIL=b git commit -m x && git push",
    "GIT_EDITOR=true git commit --amend && git push",
    "git --no-pager -c color.ui=false -P push",
    "git --no-optional-locks --literal-pathspecs push",
    "set -euo pipefail; git push",
    'echo "$GIT_DIR" && git push',
  ])("%s", (command) => {
    expect(run(command)).toEqual([]);
  });
});

describe("nodeContext reads every repository as unknown when the hook's environment relocates it", () => {
  const rfs: ReadFs = {
    realpath: (p) => p,
    readHead: () => "ref: refs/heads/feat/x\n",
    isFile: (p) => p === `${REPO}/.git/HEAD`,
  };

  it.each(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_NAMESPACE"])("inherited %s", (name) => {
    expect(run("git push", nodeContext(HOME, rfs, { [name]: "/x" }))).toEqual(unknown("bash.merge.git-push-implicit"));
  });

  it("an environment with only harmless git variables reads the checkout's branch", () => {
    expect(run("git push", nodeContext(HOME, rfs, { GIT_TERMINAL_PROMPT: "0" }))).toEqual([]);
  });
});

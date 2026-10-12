import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { fixtureClone, reflogLine, reflogPath } from "../test-support/reflog.js";
import { gitCommonDir, parseReflog, pushSignal } from "./push-signal.js";

const REPO = "octo/demo";
const BRANCH = "agent-chat/tc-demo-a";
const OTHER = "agent-chat/tc-demo-b";
const S0 = fakeSha("s0");
const S1 = fakeSha("s1");
const S2 = fakeSha("s2");

describe("parseReflog", () => {
  it("reads each complete line's old and new sha, and leaves a line still being written", () => {
    const text = `${reflogLine(S0, S1)}${reflogLine(S1, S2)}${S2} ${S0} Demo`;

    expect(parseReflog(text)).toEqual([
      { oldSha: S0, newSha: S1, message: "update by push" },
      { oldSha: S1, newSha: S2, message: "update by push" },
    ]);
  });

  it("skips a line that is not a reflog entry", () => {
    expect(parseReflog(`not a reflog line\n${reflogLine(S0, S1)}`)).toEqual([{ oldSha: S0, newSha: S1, message: "update by push" }]);
  });
});

describe("pushSignal", () => {
  it("reports a sha pushed to the branch after the mark, and nothing on the next read", () => {
    const { clone, push } = fixtureClone();
    push(BRANCH, S0, S1);
    const signal = pushSignal(() => clone);
    const mark = signal.mark(REPO, BRANCH);

    push(BRANCH, S1, S2);
    const first = signal.since(REPO, BRANCH, mark);
    const second = signal.since(REPO, BRANCH, first.cursor);

    expect(mark.last).toBe(S1);
    expect(first.shas).toEqual([S2]);
    expect(second.shas).toEqual([]);
  });

  it("ignores a push to another branch", () => {
    const { clone, push } = fixtureClone();
    push(BRANCH, S0, S1);
    const signal = pushSignal(() => clone);
    const mark = signal.mark(REPO, BRANCH);

    push(OTHER, S0, S2);

    expect(signal.since(REPO, BRANCH, mark).shas).toEqual([]);
  });

  it("never signals a branch outside agent-chat/, even with a reflog", () => {
    const { clone, push } = fixtureClone();
    const signal = pushSignal(() => clone);
    const mark = signal.mark(REPO, "feature/demo");

    push("feature/demo", S0, S1);

    expect(signal.since(REPO, "feature/demo", mark).shas).toEqual([]);
  });

  it("signals the first push to a branch that had no reflog at the mark", () => {
    const { clone, push } = fixtureClone();
    const signal = pushSignal(() => clone);
    const mark = signal.mark(REPO, BRANCH);

    push(BRANCH, S0, S1);

    expect(mark).toEqual({ offset: 0 });
    expect(signal.since(REPO, BRANCH, mark).shas).toEqual([S1]);
  });

  it("reads nothing for a repo with no clone", () => {
    const signal = pushSignal(() => undefined);

    expect(signal.since(REPO, BRANCH, signal.mark(REPO, BRANCH)).shas).toEqual([]);
  });

  it("rereads a reflog rewritten shorter than the cursor from its start", () => {
    const { clone, push } = fixtureClone();
    push(BRANCH, S0, S1);
    push(BRANCH, S1, S2);
    const signal = pushSignal(() => clone);
    const mark = signal.mark(REPO, BRANCH);

    writeFileSync(reflogPath(clone, BRANCH), reflogLine(S2, S0));

    expect(signal.since(REPO, BRANCH, mark).shas).toEqual([S0]);
  });
});

describe("gitCommonDir", () => {
  it("follows a worktree's .git file to the clone's common dir", () => {
    const { clone } = fixtureClone();
    const main = join(clone, ".git");
    const linked = join(main, "worktrees", "tc-demo");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, "commondir"), "../..\n");
    const tree = join(clone, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, ".git"), `gitdir: ${linked}\n`);

    expect(gitCommonDir(tree)).toBe(main);
  });
});

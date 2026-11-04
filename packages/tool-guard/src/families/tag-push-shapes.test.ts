import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import { nodeContext } from "../context.js";
import type { ReadFs } from "../context.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

function fakeContext(): ClassifyContext {
  return { home: HOME, readLink: () => null, readHead: (dir) => (dir === REPO ? "feat/x" : null), readScript: () => null };
}

function bash(command: string): ClassifiedAction[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, fakeContext());
}

const TAG = [expect.objectContaining({ action: "release", spelling: "bash.release.git-push-tag", subject: {} })];

describe("a changesets release tag", () => {
  it.each([
    ["a scoped package tag", "git push origin @scope/pkg@0.3.1"],
    ["a scoped package tag under refs/tags", "git push origin HEAD:refs/tags/@scope/pkg@0.3.1"],
    ["a scoped package tag pushed by its own name", "git push origin @scope/pkg@1.0.0:@scope/pkg@1.0.0"],
    ["an unscoped package tag", "git push origin pkg@2.0.0"],
  ])("reads %s as a release", (_what, command) => {
    expect(bash(command)).toEqual(TAG);
  });

  it.each([
    ["a branch named after a scoped package", "git push origin @scope/pkg"],
    ["a branch holding @ without a version", "git push origin feat/a@b"],
  ])("leaves %s alone", (_what, command) => {
    expect(bash(command)).toEqual([]);
  });
});

describe("push.followTags set with git -c", () => {
  it.each([
    ["set to true", "git -c push.followTags=true push origin feat/x"],
    ["bare, which git reads as true", "git -c push.followTags push origin feat/x"],
    ["in another letter case", "git -c PUSH.FOLLOWTAGS=yes push origin feat/x"],
    ["turned on by the last entry", "git -c push.followTags=false -c push.followTags=1 push origin feat/x"],
  ])("reads it %s as a tag push", (_what, command) => {
    expect(bash(command)).toEqual(TAG);
  });

  it.each([
    ["set to false", "git -c push.followTags=false push origin feat/x"],
    ["set empty", "git -c push.followTags= push origin feat/x"],
    ["turned off by the last entry", "git -c push.followTags=true -c push.followTags=off push origin feat/x"],
  ])("leaves it %s alone", (_what, command) => {
    expect(bash(command)).toEqual([]);
  });
});

const noFiles: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};

const port: HookPort = { context: nodeContext(HOME, noFiles), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function hook(command: string): Promise<string> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "sess-1", tool_use_id: "tu-1", cwd: REPO, tool_input: { command } });
  return (await handle(input, {}, port)).stdout;
}

describe("handle: a tag push the release shapes spell", () => {
  it.each(["git push origin @scope/pkg@0.3.1", "git -c push.followTags=true push origin feat/x"])("denies %s", async (command) => {
    const stdout = await hook(command);

    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain("bash.release.git-push-tag");
  });
});

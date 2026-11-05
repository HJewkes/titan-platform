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

function fakeContext(head: string | null): ClassifyContext {
  return { home: HOME, readLink: () => null, readHead: (dir) => (dir === REPO ? head : null), readScript: () => null };
}

function bash(command: string, head: string | null = "feat/x"): ClassifiedAction[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, fakeContext(head));
}

const spellings = (actions: ClassifiedAction[]) => actions.map((a) => a.spelling);

const TAG_PUSHES = [
  "git push origin v1",
  "git push origin refs/tags/v1",
  "git push --tags",
  "git push --follow-tags",
  "git push origin --tags",
  "git push origin v2.3.0",
  "git push origin +refs/tags/v1",
  "git push origin HEAD:refs/tags/v1",
  "git push origin v1:refs/tags/v1",
  "git push origin tags/v1",
  "git push origin :refs/tags/v1",
  "git push origin --delete v1",
  "git push origin tag v1",
  "git push origin feat/x refs/tags/v1",
];

describe("bash.release.git-push-tag", () => {
  it.each(TAG_PUSHES)("%s reads as a release", (command) => {
    expect(bash(command)).toEqual([expect.objectContaining({ action: "release", spelling: "bash.release.git-push-tag", subject: {} })]);
  });

  it("keeps the merge verdict beside a tag push to a protected branch", () => {
    expect(spellings(bash("git push origin HEAD:main v1"))).toEqual(["bash.release.git-push-tag", "bash.merge.git-push-protected"]);
  });

  it("keeps the implicit push verdict of --follow-tags on main", () => {
    expect(spellings(bash("git push --follow-tags", "main"))).toEqual(["bash.release.git-push-tag", "bash.merge.git-push-implicit"]);
  });

  it.each([
    ["a feature branch", "git push origin feat/x"],
    ["a branch whose name holds tags/", "git push origin HEAD:feat/tags/v1"],
    ["a branch named like a verb", "git push origin very-new"],
    ["a branch called tag", "git push origin tag"],
    ["no refspec", "git push"],
    ["--no-tags", "git push --no-tags origin feat/x"],
  ])("leaves a push of %s alone", (_what, command) => {
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

describe("handle: a tag push", () => {
  it.each(["git push origin v1", "git push origin refs/tags/v1", "git push --tags", "git push --follow-tags"])("denies %s", async (command) => {
    const stdout = await hook(command);

    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain("bash.release.git-push-tag");
  });

  it("lets a feature branch push through", async () => {
    expect(await hook("git push origin feat/x")).toBe("");
  });
});

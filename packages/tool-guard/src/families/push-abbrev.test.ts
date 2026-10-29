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

const spellings = (actions: ClassifiedAction[]) => actions.map((a) => a.spelling);

describe("an abbreviated git push long option", () => {
  it.each([
    ["--ta as --tags", "git push origin feat/x --ta"],
    ["--fol as --follow-tags", "git push --fol origin feat/x"],
    ["--follow as --follow-tags", "git push --follow"],
  ])("reads %s, a tag push", (_what, command) => {
    expect(spellings(bash(command))).toEqual(["bash.release.git-push-tag"]);
  });

  it.each([
    ["--al as --all", "git push origin --al"],
    ["--mir as --mirror", "git push origin --mir"],
    ["--br as --branches", "git push origin feat/x --br"],
  ])("reads %s, a push of every branch", (_what, command) => {
    expect(spellings(bash(command))).toEqual(["bash.merge.git-push-all"]);
  });

  it("reads the word after an abbreviated --repo as its value, so main names the remote", () => {
    expect(spellings(bash("git push --rep origin main"))).toEqual([]);
  });

  it.each([
    ["--t, --tags or --thin", "git push --t origin feat/x"],
    ["--fo, --force or --follow-tags", "git push --fo origin feat/x"],
    ["--no, any negated option", "git push --no origin feat/x"],
  ])("reads the ambiguous %s as a push to an unknown branch", (_what, command) => {
    expect(bash(command)).toEqual([
      expect.objectContaining({ spelling: "bash.merge.git-push-protected", subject: { branch: "unknown" } }),
    ]);
  });

  it.each([
    ["--no-ta, which turns tags off", "git push --no-ta origin feat/x"],
    ["--thi, which is --thin", "git push --thi origin feat/x"],
  ])("leaves %s alone", (_what, command) => {
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

describe("handle: an abbreviated git push long option", () => {
  it.each([
    ["git push origin feat/x --ta", "bash.release.git-push-tag"],
    ["git push origin feat/x --fol", "bash.release.git-push-tag"],
    ["git push origin feat/x --al", "bash.merge.git-push-all"],
    ["git push origin feat/x --mir", "bash.merge.git-push-all"],
    ["git push --t origin feat/x", "bash.merge.git-push-protected"],
  ])("denies %s", async (command, spelling) => {
    const stdout = await hook(command);

    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain(spelling);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentIdentity } from "../roster/types.js";
import { adopterBlocker, parkTenancyBlocker, worktreeTenancy, type TreeHolder } from "./index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A real directory, because the rule resolves symlinks and a mock cannot prove that. */
function makeTree(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tenancy-")));
  tmpDirs.push(root);
  const tree = path.join(root, ".worktrees", "scout");
  fs.mkdirSync(path.join(tree, "src"), { recursive: true });
  return tree;
}

function linkTo(target: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tenancy-link-")));
  tmpDirs.push(dir);
  const link = path.join(dir, "tree");
  fs.symlinkSync(target, link);
  return link;
}

const identity = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentId: "a1",
  name: "scout",
  profile: "implementer",
  state: "exited",
  origin: "spawned",
  spawnedBy: "human",
  spawnedAt: 1,
  brief: "",
  cwd: "",
  isolation: "worktree",
  surface: "headless",
  sessionId: "sess-1",
  lastEventAt: 1,
  generation: 1,
  ...over,
});

const predecessorIn = (tree: string): TreeHolder => ({
  agentId: "a1",
  name: "scout",
  isolation: "worktree",
  ref: { worktree: tree, branch: "agent-chat/scout" },
});

const successorIn = (cwd: string, state: AgentIdentity["state"] = "live"): AgentIdentity =>
  identity({ agentId: "a2", name: "heir", cwd, state });

/** CC-141, restating the supervisor's retire cases over the shared rule. */
describe("worktreeTenancy while a successor works in the predecessor's worktree", () => {
  it("refuses to retire the predecessor, and names the successor and --force", () => {
    const tree = makeTree();

    const verdict = worktreeTenancy(predecessorIn(tree), [successorIn(tree)], false);

    expect(verdict?.refusal).toMatch(/heir \(not retired\) is working in it/);
    expect(verdict?.refusal).toMatch(/--force/);
    expect(verdict?.warning).toBeUndefined();
  });

  it("releases it under --force, and names the tree and branch it released", () => {
    const tree = makeTree();

    const verdict = worktreeTenancy(predecessorIn(tree), [successorIn(tree)], true);

    expect(verdict?.refusal).toBeUndefined();
    expect(verdict?.warning).toContain(`released the worktree ${tree} and branch agent-chat/scout`);
    expect(verdict?.warning).toMatch(/while heir was still working in it/);
  });

  it("refuses when the successor reached the worktree through a symlink", () => {
    const tree = makeTree();
    const link = linkTo(tree);

    const verdict = worktreeTenancy(predecessorIn(tree), [successorIn(path.join(link, "src"))], false);

    expect(verdict?.refusal).toMatch(/heir \(not retired\) is working in it/);
  });

  it("refuses when the predecessor recorded its worktree through a symlink", () => {
    const tree = makeTree();
    const link = linkTo(tree);

    const verdict = worktreeTenancy(predecessorIn(link), [successorIn(tree)], false);

    expect(verdict?.refusal).toMatch(/heir \(not retired\) is working in it/);
  });

  it("does not count an agent in a sibling tree whose name extends this one", () => {
    const tree = makeTree();
    fs.mkdirSync(`${tree}-2`);

    expect(worktreeTenancy(predecessorIn(tree), [successorIn(`${tree}-2`)], false)).toBeUndefined();
  });

  it("leaves an adopted tree and a non-worktree isolation alone", () => {
    const tree = makeTree();
    const adopted = { ...predecessorIn(tree), ref: { worktree: tree, assigned: "true" } };
    const shared = { ...predecessorIn(tree), isolation: "none" };

    expect(worktreeTenancy(adopted, [successorIn(tree)], false)).toBeUndefined();
    expect(worktreeTenancy(shared, [successorIn(tree)], false)).toBeUndefined();
  });
});

describe("adopterBlocker", () => {
  it("skips an agent whose worktree an unretired adopter still works in", () => {
    const tree = makeTree();
    const owner = identity({ cwd: tree });

    const reason = adopterBlocker(owner, { worktree: tree, assigned: false }, [owner, successorIn(tree, "exited")]);

    expect(reason).toBe("heir (not retired) still works in its worktree");
  });

  it("lets an agent go when only it works in its tree, or the tree was adopted", () => {
    const tree = makeTree();
    const owner = identity({ cwd: tree });

    expect(adopterBlocker(owner, { worktree: tree, assigned: false }, [owner])).toBeUndefined();
    expect(adopterBlocker(owner, { worktree: tree, assigned: true }, [owner, successorIn(tree)])).toBeUndefined();
  });
});

describe("parkTenancyBlocker", () => {
  it("refuses a tree a live successor occupies, naming the successor", () => {
    const tree = makeTree();

    const reason = parkTenancyBlocker(identity({ cwd: tree }), tree, [successorIn(tree, "live")]);

    expect(reason).toBe(`heir is live in ${tree}; not parked`);
  });

  it("refuses a tree a finished but unretired identity works in, naming it", () => {
    const tree = makeTree();
    const predecessor = identity({ cwd: tree });
    const successor = successorIn(tree, "exited");

    const bySuccessor = parkTenancyBlocker(successor, tree, [predecessor, successor]);
    const byPredecessor = parkTenancyBlocker(predecessor, tree, [predecessor, successor]);

    expect(bySuccessor).toMatch(/^scout \(not retired\) also works in /);
    expect(byPredecessor).toMatch(/^heir \(not retired\) also works in .*retire heir first$/);
  });

  it("parks a tree nobody else works in", () => {
    const tree = makeTree();
    const agent = identity({ cwd: tree });

    expect(parkTenancyBlocker(agent, tree, [agent, successorIn(`${tree}-2`)])).toBeUndefined();
  });
});

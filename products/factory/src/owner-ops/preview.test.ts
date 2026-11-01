import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deployLockPath } from "../deploy-lock.js";
import { deployHoldPath, deployPausePath } from "../deploy-pause.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import { callCommand, shepherdFixture } from "../test-support/shepherd.js";
import type { OpPreview } from "./preview.js";

const REPO = "example-org/example-repo";
const H = "a".repeat(40);
const MERGE_SHA = "c".repeat(40);

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

/** The deployer's state dir under a fresh XDG state home, which serve reads the pause from. */
function deployStateDir(): string {
  const home = mkdtempSync(join(tmpdir(), "factory-preview-state-"));
  dirs.push(home);
  vi.stubEnv("XDG_STATE_HOME", home);
  const stateDir = join(home, "titan-factory");
  mkdirSync(stateDir);
  return stateDir;
}

function world() {
  const fixture = shepherdFixture();
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  const preview = async (op: object) => callCommand<OpPreview>(host, fixture.routes, "owner-op.preview", { op });
  return { fixture, host, preview };
}

describe("owner-op.preview", () => {
  it("reads a merged PR as merged with its merge sha and no head to act at", async () => {
    const { fixture, preview } = world();
    const { number } = fixture.fake.addPr({ headSha: H, state: "closed", merged: true, mergeSha: MERGE_SHA });

    const answer = await preview({ kind: "merge-at-head", repo: REPO, pr: number, headSha: H });

    expect(answer.ok).toBe(true);
    const pr = answer.ok ? answer.data.pr : undefined;
    expect(pr).toMatchObject({ state: "merged", mergeSha: MERGE_SHA });
    expect(pr).not.toHaveProperty("head");
  });

  it("reads an open PR's head from GitHub, not from the op, with its Shepherd hold", async () => {
    const { fixture, preview } = world();
    const { number } = fixture.fake.addPr({ headSha: H, title: "Synthetic change" });
    const store = fixture.routes.shepherd!.store.get();
    store.register({ repo: REPO, pr: number, runId: "run-held", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    store.hold("run-held", "owner-asked: synthetic question");

    const answer = await preview({ kind: "release-hold", repo: REPO, pr: number, headSha: "b".repeat(40), holdClass: "owner-asked" });

    expect(answer.ok && answer.data).toMatchObject({
      kind: "release-hold",
      authority: { verdict: "gate", ruleId: "HV-OR" },
      pr: { state: "open", head: H, title: "Synthetic change", shepherd: { runId: "run-held", ownerHold: "owner-asked: synthetic question" } },
    });
  });

  it("shows the owner-remote gate for closing a PR, with the PR read back", async () => {
    const { fixture, preview } = world();
    const { number } = fixture.fake.addPr({ headSha: H, title: "Synthetic change" });

    const answer = await preview({ kind: "close-pr", repo: REPO, pr: number, headSha: H });

    expect(answer.ok && answer.data).toMatchObject({ authority: { verdict: "gate", ruleId: "PRC-OR" }, pr: { state: "open", head: H } });
  });

  it("reads a gate the store does not hold as missing", async () => {
    const { preview } = world();

    const answer = await preview({ kind: "resolve-gate", gateId: "run-x/approve-merge", headSha: H, decision: "merge" });

    expect(answer.ok && answer.data.gate).toEqual({ gateId: "run-x/approve-merge", status: "missing" });
  });

  describe("a retire-agent op", () => {
    const AGENT = { name: "item-42", agentId: "9e3faa6c", state: "exited", presence: "exited", status: "finished", profile: "impl", surface: "headless", cwd: "/work/tree", sessionId: "s-1", generation: 1, spawnedBy: "coordinator" };
    const retireOp = { kind: "retire-agent", name: "item-42", agentId: "0000aaaa", force: false };

    function rosterWorld(rows: (typeof AGENT)[]) {
      const w = world();
      Object.assign(w.fixture.routes.shepherd!, { roster: { rows: async () => rows } });
      return w;
    }

    // Kills: reading the agent id back from the op instead of the roster, or showing a retired row as the holder.
    it("reads the agent holding the name from agent-chat's roster, with RET-OR's allow", async () => {
      const { preview } = rosterWorld([{ ...AGENT, agentId: "old00000", state: "retired", status: "retired" }, AGENT]);

      const answer = await preview(retireOp);

      expect(answer.ok && answer.data).toMatchObject({
        authority: { verdict: "allow", ruleId: "RET-OR" },
        agent: { name: "item-42", holder: { agentId: "9e3faa6c", state: "exited", profile: "impl", spawnedBy: "coordinator" }, exited: true, liveRun: null },
      });
    });

    // Kills: dropping the live-run read, so the console offers a retire the factory then refuses.
    it("names the live Shepherd run the agent implements", async () => {
      const w = rosterWorld([AGENT]);
      const { number: pr } = w.fixture.fake.addPr({ headSha: H });
      const registered = await callCommand<{ runId: string }>(w.host, w.fixture.routes, "shepherd.register", { repo: REPO, pr, task: "demo/T-1", implementer: "item-42" });

      const answer = await w.preview(retireOp);

      expect(registered.ok && answer.ok && answer.data.agent?.liveRun).toBe(registered.ok ? registered.data.runId : "unregistered");
    });

    it("reads a name no unretired agent holds as having no holder", async () => {
      const { preview } = rosterWorld([{ ...AGENT, state: "retired", status: "retired" }]);

      const answer = await preview(retireOp);

      expect(answer.ok && answer.data.agent).toEqual({ name: "item-42", exited: false, forceStop: expect.stringContaining("no unretired agent"), liveRun: null });
    });

    it("refuses as unavailable without agent-chat's roster", async () => {
      const { preview } = world();

      expect((await preview(retireOp)).ok).toBe(false);
    });
  });

  it("refuses an op the schema does not admit", async () => {
    const { preview } = world();

    const answer = await preview({ kind: "merge-at-head", repo: REPO, pr: 1, headSha: "a".repeat(39) });

    expect(answer.ok).toBe(false);
  });

  it("reads a close-pr op's PR at GitHub's head, which the console pins the close to", async () => {
    const { fixture, preview } = world();
    const { number } = fixture.fake.addPr({ headSha: H, title: "Synthetic stale change" });

    const answer = await preview({ kind: "close-pr", repo: REPO, pr: number, headSha: "b".repeat(40) });

    expect(answer.ok && answer.data.pr).toMatchObject({ repo: REPO, pr: number, state: "open", head: H, title: "Synthetic stale change" });
  });

  it("reads a deploy-pause-clear op's pause, the manual hold it leaves, and whether a deployer runs", async () => {
    const { preview } = world();
    const stateDir = deployStateDir();
    const pause = { pausedAt: "2026-10-18T12:00:00.000Z", target: "f".repeat(40), from: "e".repeat(40), why: "synthetic watch failure", rollback: "verified" };
    writeFileSync(deployPausePath(stateDir), JSON.stringify(pause));
    writeFileSync(deployHoldPath(stateDir), JSON.stringify({ heldAt: pause.pausedAt, reason: "synthetic hand hold" }));

    const answer = await preview({ kind: "deploy-pause-clear", pausedAt: pause.pausedAt, target: pause.target });

    expect(answer.ok && answer.data.pause).toEqual({
      paused: true,
      since: pause.pausedAt,
      reason: "synthetic watch failure",
      lastRollback: { target: pause.target, from: pause.from, status: "verified" },
      deployerRunning: false,
      manualHold: "synthetic hand hold",
    });
  });

  it("reads a live pid in the deploy lock as a running deployer", async () => {
    const { preview } = world();
    const stateDir = deployStateDir();
    writeFileSync(deployLockPath(stateDir), String(process.pid));

    const answer = await preview({ kind: "deploy-pause-clear", pausedAt: "2026-10-18T12:00:00.000Z", target: "f".repeat(40) });

    expect(answer.ok && answer.data.pause).toMatchObject({ paused: false, deployerRunning: true, manualHold: null });
  });
});

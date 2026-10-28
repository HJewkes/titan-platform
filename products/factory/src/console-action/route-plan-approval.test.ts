import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_HEADER, silentLogger } from "@titan-design/daemon";
import { fakeGitHub, githubPort } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { startFactoryServer, type FactoryServer } from "../serve.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import type { ShepherdStore } from "../shepherd/store.js";
import { TEST_BRIEF } from "../test-support/brief.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { CONSOLE_ACTION_PATH } from "./route.js";

const REPO = "example-org/example-repo";
const TASK = "example/TP-1";
const NOW_MS = Date.parse("2026-10-28T12:00:00.000Z");
const ACTION_ID = "act-1";
const SKILL = { gate: "skill", scope: { paths: [".claude/skills/x/SKILL.md"] }, round: "round-1" };

/** A run that stays live on an open gate, standing in for a shepherd-pr run of the task. */
const parked = defineWorkflow({
  name: "parked",
  steps: [{ id: "wait", kind: "assisted" }],
  run: async (ctx) => {
    await ctx.assisted("wait", "Confirm the synthetic wait?", { brief: TEST_BRIEF });
  },
});

const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface World {
  server: FactoryServer;
  actionsDir: string;
  store: () => ShepherdStore;
}

async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "factory-console-plan-approval-"));
  dirs.push(dir);
  const actionsDir = join(dir, "actions");
  mkdirSync(actionsDir);
  const fixture = shepherdFixture({ frozen: true, port: githubPort(fakeGitHub({ repo: REPO }).wire) });
  const server = await startFactoryServer({
    dbPath: join(dir, "factory.sqlite3"),
    workflows: [parked],
    routes: fixture.routes,
    resyncOnStart: false,
    now: () => NOW_MS,
    gatePollMs: 10,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "test", behindMain: { status: () => 0, refresh: async () => undefined } },
    consoleAnswers: { roundsDir: join(dir, "rounds"), actionsDir },
  });
  servers.push(server);
  return { server, actionsDir, store: () => fixture.routes.shepherd!.store.get() };
}

/** Registers PR `pr` of the task under a live run and returns its id. */
async function liveRegistration(w: World, pr: number): Promise<string> {
  const runId = w.server.host.runtime.start("parked", {});
  await vi.waitFor(() => expect(w.server.host.gates.get(`${runId}/wait`)?.status).toBe("pending"));
  w.store().register({ repo: REPO, pr, runId, task: TASK, implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return runId;
}

/** The console's record for a confirmed plan-approval tap; returns the confirm event its bytes stand for. */
function writeApproval(w: World, approval: Record<string, unknown> = SKILL): string {
  const record = JSON.stringify({ id: ACTION_ID, itemId: `plan:${TASK}`, action: { kind: "plan-approval", task: TASK, repo: REPO, ...approval }, at: new Date(NOW_MS).toISOString() });
  writeFileSync(join(w.actionsDir, `${ACTION_ID}.json`), record, { mode: 0o600 });
  return `action:${createHash("sha256").update(record).digest("hex")}`;
}

async function post(server: FactoryServer): Promise<[number, unknown]> {
  const res = await fetch(`http://127.0.0.1:${server.port}${CONSOLE_ACTION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_HEADER]: "test" },
    body: JSON.stringify({ actionId: ACTION_ID }),
  });
  return [res.status, await res.json()];
}

describe("POST /owner/console-action plan-approval", () => {
  it("records a confirmed approval once, unclaimed with no registration, and the task's next registration claims it", async () => {
    const w = await world();
    writeApproval(w);

    const first = await post(w.server);
    const repeat = await post(w.server);
    const runId = await liveRegistration(w, 1);

    expect([first, repeat]).toEqual([
      [200, { outcome: "plan-approved", task: TASK, gate: "skill", claimedRun: null }],
      [200, { outcome: "already", task: TASK }],
    ]);
    expect(w.store().planApprovals().forRun(runId, TASK, REPO)).toEqual([SKILL]);
  });

  it("claims the approval for the task's one live registration at write", async () => {
    const w = await world();
    const runId = await liveRegistration(w, 1);
    writeApproval(w);

    const answer = await post(w.server);

    expect(answer).toEqual([200, { outcome: "plan-approved", task: TASK, gate: "skill", claimedRun: runId }]);
    expect(w.store().planApprovals().forRun(runId, TASK, REPO)).toEqual([SKILL]);
  });

  it("leaves the approval unclaimed when two live registrations name the task", async () => {
    const w = await world();
    const runs = [await liveRegistration(w, 1), await liveRegistration(w, 2)];
    writeApproval(w);

    const answer = await post(w.server);

    expect(answer).toEqual([200, { outcome: "plan-approved", task: TASK, gate: "skill", claimedRun: null }]);
    expect(runs.map((runId) => w.store().planApprovals().forRun(runId, TASK, REPO))).toEqual([[], []]);
  });

  it("refuses a record in the old line-entry shape with 422 record and writes no approval", async () => {
    const w = await world();
    const runId = await liveRegistration(w, 1);
    writeApproval(w, { gate: "ci-policy", scope: { paths: [".github/x.yml"], ciPolicyKeys: ["other"], entries: [{ path: ".github/x.yml", side: "+", n: 1, text: "x" }] }, round: "round-1" });

    const answer = await post(w.server);

    expect(answer).toMatchObject([422, { outcome: "refused", reason: "record" }]);
    expect(w.store().planApprovals().forRun(runId, TASK, REPO)).toEqual([]);
  });
});

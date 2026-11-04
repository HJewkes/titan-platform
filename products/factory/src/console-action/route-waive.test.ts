import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_HEADER, silentLogger } from "@titan-design/daemon";
import { fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { approveMergeDecision, sentBackDecision } from "../gate-brief.js";
import { startFactoryServer, type FactoryServer } from "../serve.js";
import { TEST_BRIEF } from "../test-support/brief.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { CONSOLE_ACTION_PATH } from "./route.js";

const REPO = "example-org/example-repo";
const NOW_MS = Date.parse("2026-10-18T12:00:00.000Z");
const H = "a".repeat(40);
const H2 = "b".repeat(40);
const ACTION_ID = "act-1";

const mergeGate = defineWorkflow({
  name: "merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const pr = Number(ctx.param("pr")!);
    const { schema } = approveMergeDecision({ repo: REPO, pr, headSha: H, reason: "synthetic reason", reviewedMerge: false, sendBack: false });
    await ctx.assisted("approve-merge", `Merge PR #${pr} in ${REPO} at head ${H}? CI is green.`, { schema, brief: TEST_BRIEF });
  },
});

/** Shepherd's sent-back gate as `sentBackGate` opens it, offering the fix-proof waiver when `waivable` is set. */
const sentBack = defineWorkflow({
  name: "sent-back-gate",
  steps: [{ id: "sh-sent-back", kind: "assisted" }],
  run: async (ctx) => {
    const pr = Number(ctx.param("pr")!);
    const built = sentBackDecision({ repo: REPO, pr, headSha: H, situation: "synthetic reason", waivable: ctx.param("waivable") === "true" });
    await ctx.assisted("sh-sent-back", `Changes requested on PR #${pr} in ${REPO} at head ${H}: synthetic reason.`, { schema: built.schema, brief: built.brief });
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
  github: FakeGitHub;
  pr: number;
  mergeGateId: string;
  sentBackId: string;
  /** Writes the console's record for a confirmed tap on the sent-back gate; returns the confirm event its bytes stand for. */
  record: (action?: Record<string, unknown>, actionId?: string) => string;
}

function writeRecord(actionsDir: string, gateId: string, action: Record<string, unknown>, actionId: string): string {
  const record = JSON.stringify({ id: actionId, itemId: `gate:${gateId}`, action: { kind: "resolve-gate", gateId, headSha: H, ...action }, confirm: "d".repeat(64), at: new Date(NOW_MS).toISOString() });
  writeFileSync(join(actionsDir, `${actionId}.json`), record, { mode: 0o600 });
  return `action:${createHash("sha256").update(record).digest("hex")}`;
}

async function pendingGate(server: FactoryServer, workflow: string, pr: number, params: Record<string, string>, step: string): Promise<string> {
  const runId = server.host.runtime.start(workflow, { pr: String(pr), ...params });
  await vi.waitFor(() => expect(server.host.gates.get(`${runId}/${step}`)?.status).toBe("pending"));
  return `${runId}/${step}`;
}

/** A factory serving console actions, with one PR holding an approve-merge gate and a sent-back gate. */
async function world(params: Record<string, string> = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "factory-console-waive-"));
  dirs.push(dir);
  const actionsDir = join(dir, "actions");
  mkdirSync(actionsDir);
  const github = fakeGitHub({ repo: REPO });
  const fixture = shepherdFixture({ frozen: true, port: githubPort(github.wire) });
  const server = await startFactoryServer({
    dbPath: join(dir, "factory.sqlite3"),
    workflows: [mergeGate, sentBack],
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
  const { number: pr } = github.addPr({ headSha: H });
  const mergeGateId = await pendingGate(server, "merge-gate", pr, {}, "approve-merge");
  const sentBackId = await pendingGate(server, "sent-back-gate", pr, params, "sh-sent-back");
  const record = (action: Record<string, unknown> = {}, actionId = ACTION_ID) =>
    writeRecord(actionsDir, sentBackId, { runId: sentBackId.split("/")[0], stepId: "sh-sent-back", repo: REPO, pr, decision: "await-new-head", ...action }, actionId);
  return { server, github, pr, mergeGateId, sentBackId, record };
}

const post = (server: FactoryServer, actionId: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${CONSOLE_ACTION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_HEADER]: "test" },
    body: JSON.stringify({ actionId }),
  });

const reply = async (res: Response): Promise<[number, unknown]> => [res.status, await res.json()];

describe("POST /owner/console-action waive-proof", () => {
  it("resolves waive-proof on a waivable gate with the gate's head, as owner-remote bound to the record's sha256", async () => {
    const w = await world({ waivable: "true" });
    const confirmEvent = w.record({ decision: "waive-proof" });

    const res = await post(w.server, ACTION_ID);

    expect(await reply(res)).toEqual([200, { outcome: "resolved", gateId: w.sentBackId }]);
    const gate = w.server.host.gates.get(w.sentBackId);
    expect(gate?.payload).toEqual({ decision: "waive-proof", headSha: H });
    expect(gate?.resolvedBy).toEqual({ class: "owner-remote", id: "titan-console", channel: "console:inbox", confirmEvent });
  });

  it("refuses with 403 class a waive-proof on a sent-back gate whose schema does not offer it, leaving the gate pending", async () => {
    const w = await world();
    w.record({ decision: "waive-proof" });

    const res = await post(w.server, ACTION_ID);

    expect(await reply(res)).toMatchObject([403, { outcome: "refused", reason: "class", detail: expect.stringContaining("waive-proof") }]);
    expect(w.server.host.gates.get(w.sentBackId)?.status).toBe("pending");
  });

  it("refuses with 403 class a merge on a waivable sent-back gate and a waive-proof on an approve-merge gate", async () => {
    const w = await world({ waivable: "true" });
    w.record({ decision: "merge" }, "merge");
    w.record({ gateId: w.mergeGateId, runId: w.mergeGateId.split("/")[0], stepId: "approve-merge", decision: "waive-proof" }, "waive");

    const outcomes = await Promise.all(["merge", "waive"].map(async (actionId) => reply(await post(w.server, actionId))));

    expect(outcomes).toMatchObject([
      [403, { outcome: "refused", reason: "class" }],
      [403, { outcome: "refused", reason: "class" }],
    ]);
    expect([w.server.host.gates.get(w.sentBackId)?.status, w.server.host.gates.get(w.mergeGateId)?.status]).toEqual(["pending", "pending"]);
  });

  it("answers 409 moved with GitHub's head when the PR moved past a waive-proof record's head, and leaves the gate pending", async () => {
    const w = await world({ waivable: "true" });
    w.github.pushHead(w.pr, H2);
    w.record({ decision: "waive-proof" });

    const res = await post(w.server, ACTION_ID);

    expect(await reply(res)).toEqual([409, { outcome: "moved", currentHead: H2 }]);
    expect(w.server.host.gates.get(w.sentBackId)?.status).toBe("pending");
  });
});

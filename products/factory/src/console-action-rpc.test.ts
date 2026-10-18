import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_HEADER, silentLogger } from "@titan-design/daemon";
import { fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import type { GateRule } from "@titan-design/hitl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CONSOLE_ACTION_PATH, MAX_ACTION_RECORD_BYTES } from "./console-action-rpc.js";
import { defineWorkflow } from "./definition.js";
import { approveMergeDecision } from "./gate-brief.js";
import { createFactoryRegistry } from "./registry.js";
import { startFactoryServer, type FactoryServer } from "./serve.js";
import { TEST_BRIEF } from "./test-support/brief.js";
import { shepherdFixture } from "./test-support/shepherd.js";

const REPO = "example-org/example-repo";
const NOW_MS = Date.parse("2026-10-18T12:00:00.000Z");
const H = "a".repeat(40);
const H2 = "b".repeat(40);
const ACTION_ID = "act-1";

/** A rule that omits owner-remote, so the store itself refuses a console tap. */
const OWNER_TERMINAL_ONLY: GateRule = { table: "example-table", version: "1", ruleId: "example-row", resolvers: ["owner-terminal"] };

const mergeGate = defineWorkflow({
  name: "merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const pr = ctx.param("pr")!;
    const policy = ctx.param("policy") ?? "authority/MRG-AU";
    const prompt = `Merge PR #${pr} in ${REPO} at head ${H}? CI is green. Policy ${policy}: synthetic reason`;
    const { schema } = approveMergeDecision({ repo: REPO, pr: Number(pr), headSha: H, reason: "synthetic reason", reviewedMerge: false, sendBack: false });
    const rule = ctx.param("stamp") === "owner-terminal" ? OWNER_TERMINAL_ONLY : undefined;
    await ctx.assisted("approve-merge", prompt, { schema, brief: TEST_BRIEF, ...(rule && { rule }) });
  },
});

/** A gate the console must never answer, under the step id the hard-stop classes key on. */
const sideGate = (step: string) =>
  defineWorkflow({
    name: `side-${step}`,
    steps: [{ id: step, kind: "assisted" }],
    run: async (ctx) => {
      await ctx.assisted(step, `Confirm ${step} for the synthetic unit?`, { brief: TEST_BRIEF });
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
  actionsDir: string;
  runId: string;
  gateId: string;
  pr: number;
}

interface WorldOptions {
  actions?: boolean;
  policy?: string;
  stamp?: "owner-terminal";
}

async function world({ actions = true, policy, stamp }: WorldOptions = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "factory-console-action-"));
  dirs.push(dir);
  const actionsDir = join(dir, "actions");
  mkdirSync(actionsDir);
  const github = fakeGitHub({ repo: REPO });
  const fixture = shepherdFixture({ frozen: true, port: githubPort(github.wire) });
  const server = await startFactoryServer({
    dbPath: join(dir, "factory.sqlite3"),
    workflows: [mergeGate, sideGate("device-confirm"), sideGate("after-stages")],
    routes: fixture.routes,
    resyncOnStart: false,
    now: () => NOW_MS,
    gatePollMs: 10,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "test", behindMain: { status: () => 0, refresh: async () => undefined } },
    consoleAnswers: { roundsDir: join(dir, "rounds"), ...(actions && { actionsDir }) },
  });
  servers.push(server);
  const { number: pr } = github.addPr({ headSha: H });
  const runId = server.host.runtime.start("merge-gate", { pr: String(pr), ...(policy && { policy }), ...(stamp && { stamp }) });
  const gateId = `${runId}/approve-merge`;
  await vi.waitFor(() => expect(server.host.gates.get(gateId)?.status).toBe("pending"));
  return { server, github, actionsDir, runId, gateId, pr };
}

/** Opens a gate of another class on the same server and returns its id. */
async function openSideGate(w: World, step: string): Promise<{ runId: string; gateId: string }> {
  const runId = w.server.host.runtime.start(`side-${step}`, {});
  const gateId = `${runId}/${step}`;
  await vi.waitFor(() => expect(w.server.host.gates.get(gateId)?.status).toBe("pending"));
  return { runId, gateId };
}

/** The console's record for a confirmed tap; returns the confirm event its bytes stand for. */
function writeRecord(w: World, action: Record<string, unknown> = {}, actionId = ACTION_ID): string {
  const record = JSON.stringify({
    id: actionId,
    itemId: `gate:${w.gateId}`,
    action: { kind: "resolve-gate", gateId: w.gateId, runId: w.runId, stepId: "approve-merge", repo: REPO, pr: w.pr, headSha: H, decision: "merge", ...action },
    confirm: "d".repeat(64),
    at: new Date(NOW_MS).toISOString(),
  });
  writeFileSync(join(w.actionsDir, `${actionId}.json`), record, { mode: 0o600 });
  return `action:${createHash("sha256").update(record).digest("hex")}`;
}

const post = (server: FactoryServer, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${CONSOLE_ACTION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_HEADER]: "test" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const reply = async (res: Response): Promise<[number, unknown]> => [res.status, await res.json()];

describe("POST /owner/console-action", () => {
  it("is not mounted without consoleAnswers.actionsDir, so the route 404s and the gate stays pending", async () => {
    const w = await world({ actions: false });
    writeRecord(w);

    const res = await post(w.server, { actionId: ACTION_ID });

    expect(res.status).toBe(404);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("resolves the gate as merge at the head, as owner-remote from the console inbox bound to the record's sha256", async () => {
    const w = await world();
    const confirmEvent = writeRecord(w);

    const res = await post(w.server, { actionId: ACTION_ID });

    expect(await reply(res)).toEqual([200, { outcome: "resolved", gateId: w.gateId }]);
    const gate = w.server.host.gates.get(w.gateId);
    expect(gate?.payload).toEqual({ decision: "merge", headSha: H });
    expect(gate?.resolvedBy).toEqual({ class: "owner-remote", id: "titan-console", channel: "console:inbox", confirmEvent });
  });

  it("reads a replayed action id as already, without resolving the gate a second time", async () => {
    const w = await world();
    writeRecord(w);
    await post(w.server, { actionId: ACTION_ID });
    const first = w.server.host.gates.get(w.gateId);

    const replay = await post(w.server, { actionId: ACTION_ID });

    expect(await reply(replay)).toEqual([200, { outcome: "already", gateId: w.gateId }]);
    expect(w.server.host.gates.get(w.gateId)).toEqual(first);
  });

  it("reads a gate another record resolved as gone, not already", async () => {
    const w = await world();
    writeRecord(w);
    await post(w.server, { actionId: ACTION_ID });
    writeRecord(w, {}, "act-2");

    const other = await post(w.server, { actionId: "act-2" });

    expect(await reply(other)).toMatchObject([410, { outcome: "gone" }]);
  });

  it("answers 409 moved with GitHub's head when the PR moved past the record's head, and leaves the gate pending", async () => {
    const w = await world();
    writeRecord(w);
    w.github.pushHead(w.pr, H2);

    const res = await post(w.server, { actionId: ACTION_ID });

    expect(await reply(res)).toEqual([409, { outcome: "moved", currentHead: H2 }]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("answers 409 moved with the gate's head when the record names a head the gate does not ask about", async () => {
    const w = await world();
    writeRecord(w, { headSha: H2 });

    const res = await post(w.server, { actionId: ACTION_ID });

    expect(await reply(res)).toEqual([409, { outcome: "moved", currentHead: H }]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("answers 410 gone for a closed PR, a missing record and an unknown gate", async () => {
    const w = await world();
    writeRecord(w);
    writeRecord(w, { gateId: `${w.runId}/approve-merge:9` }, "act-unknown");
    await w.github.wire.closePr(REPO, w.pr);

    const closed = await post(w.server, { actionId: ACTION_ID });
    const missing = await post(w.server, { actionId: "act-never-written" });
    const unknown = await post(w.server, { actionId: "act-unknown" });

    expect(await reply(closed)).toMatchObject([410, { outcome: "gone", reason: expect.stringContaining("closed") }]);
    expect(await reply(missing)).toMatchObject([410, { outcome: "gone", reason: expect.stringContaining("no action record") }]);
    expect(await reply(unknown)).toMatchObject([410, { outcome: "gone", reason: expect.stringContaining("no gate") }]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("refuses a hardware gate with 403 class, leaving it pending", async () => {
    const w = await world();
    const side = await openSideGate(w, "device-confirm");
    writeRecord(w, { ...side, stepId: "device-confirm" });

    const res = await post(w.server, { actionId: ACTION_ID });

    expect(await reply(res)).toMatchObject([403, { outcome: "refused", reason: "class", detail: expect.stringContaining("a hardware gate") }]);
    expect(w.server.host.gates.get(side.gateId)?.status).toBe("pending");
  });

  it("refuses an after-stages gate with 403 class, leaving it pending", async () => {
    const w = await world();
    const side = await openSideGate(w, "after-stages");
    writeRecord(w, { ...side, stepId: "after-stages" });

    const res = await post(w.server, { actionId: ACTION_ID });

    expect(await reply(res)).toMatchObject([403, { outcome: "refused", reason: "class", detail: expect.stringContaining("a release gate") }]);
    expect(w.server.host.gates.get(side.gateId)?.status).toBe("pending");
  });

  it("refuses with 403 resolver when the gate's rule admits owner-terminal only, leaving the gate pending", async () => {
    const w = await world({ stamp: "owner-terminal" });
    writeRecord(w);

    const res = await post(w.server, { actionId: ACTION_ID });

    expect(await reply(res)).toMatchObject([403, { outcome: "refused", reason: "resolver" }]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("resolves a Version Packages approve-merge gate under the shepherd-release table", async () => {
    const w = await world({ policy: "shepherd-release/version-packages" });
    writeRecord(w);

    const res = await post(w.server, { actionId: ACTION_ID });

    expect(await reply(res)).toEqual([200, { outcome: "resolved", gateId: w.gateId }]);
  });

  it("refuses with 422 mismatch a record whose PR is not the one the gate asks about", async () => {
    const w = await world();
    writeRecord(w, { pr: w.pr + 1 });

    const res = await post(w.server, { actionId: ACTION_ID });

    expect(await reply(res)).toMatchObject([422, { outcome: "refused", reason: "mismatch" }]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("refuses a symlinked record, a directory, an oversize record and a misshapen one instead of reading them", async () => {
    const w = await world();
    writeRecord(w, {}, "elsewhere");
    symlinkSync(join(w.actionsDir, "elsewhere.json"), join(w.actionsDir, "linked.json"));
    mkdirSync(join(w.actionsDir, "dir.json"));
    writeFileSync(join(w.actionsDir, "big.json"), "x".repeat(MAX_ACTION_RECORD_BYTES + 1));
    writeRecord(w, { decision: "send-back" }, "misshapen");

    const outcomes = await Promise.all(["linked", "dir", "big", "misshapen"].map(async (actionId) => reply(await post(w.server, { actionId }))));

    expect(outcomes).toMatchObject([
      [422, { outcome: "refused", reason: "record-unreadable" }],
      [422, { outcome: "refused", reason: "record-unreadable", detail: expect.stringContaining("not a regular file") }],
      [422, { outcome: "refused", reason: "record-unreadable", detail: expect.stringContaining("over") }],
      [422, { outcome: "refused", reason: "record" }],
    ]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("takes only {actionId} in the body, and rejects an id that climbs out of the actions dir", async () => {
    const w = await world();
    writeRecord(w);

    const extra = await post(w.server, { actionId: ACTION_ID, gateId: w.gateId });
    const climbing = await post(w.server, { actionId: `../actions/${ACTION_ID}` });

    expect([extra.status, climbing.status]).toEqual([400, 400]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("resolves once under a concurrent double post of one record: the other reads already", async () => {
    const w = await world();
    writeRecord(w);

    const responses = await Promise.all([post(w.server, { actionId: ACTION_ID }), post(w.server, { actionId: ACTION_ID })]);

    const outcomes = await Promise.all(responses.map(async (res) => z.object({ outcome: z.string() }).parse(await res.json()).outcome));
    expect(outcomes.sort()).toEqual(["already", "resolved"]);
  });

  it("is no registry command, and so no MCP tool", () => {
    const names = createFactoryRegistry().list().map((cmd) => cmd.name);

    expect(names.filter((name) => /console|action/i.test(name))).toEqual([]);
  });
});

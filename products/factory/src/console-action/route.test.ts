import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLIENT_HEADER, silentLogger } from "@titan-design/daemon";
import { fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import type { GateRule } from "@titan-design/hitl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../definition.js";
import { approveMergeDecision, sentBackDecision } from "../gate-brief.js";
import { OWNER_OPS_LEDGER } from "../owner-ops/ledger.js";
import { createFactoryRegistry } from "../registry.js";
import { startFactoryServer, type FactoryServer } from "../serve.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import type { ShepherdStore } from "../shepherd/store.js";
import { TEST_BRIEF } from "../test-support/brief.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { MAX_ACTION_RECORD_BYTES } from "./record.js";
import { CONSOLE_ACTION_PATH, MAX_ACTION_BODY_BYTES } from "./route.js";

const REPO = "example-org/example-repo";
const NOW_MS = Date.parse("2026-10-18T12:00:00.000Z");
const H = "a".repeat(40);
const H2 = "b".repeat(40);
const ACTION_ID = "act-1";
const OWNER = "owner-asked: synthetic scope question";
const G10 = "g10-review: synthetic auth change";
const HELD_RUN = "run-held";

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

/** Shepherd's sent-back gate as `sentBackGate` opens it; `decisions` swaps in a schema that offers only those. */
const sentBack = defineWorkflow({
  name: "sent-back-gate",
  steps: [{ id: "sh-sent-back", kind: "assisted" }],
  run: async (ctx) => {
    const pr = Number(ctx.param("pr")!);
    const prompt = `Changes requested on PR #${pr} in ${REPO} at head ${H}: synthetic reason. Await a new head or abandon?`;
    const built = sentBackDecision({ repo: REPO, pr, headSha: H, situation: "synthetic reason", waivable: ctx.param("waivable") === "true" });
    const decisions = ctx.param("decisions")?.split(",");
    const schema = decisions ? z.object({ decision: z.enum(decisions) }) : built.schema;
    await ctx.assisted("sh-sent-back", prompt, { schema, brief: built.brief });
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
  store: () => ShepherdStore;
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
    workflows: [mergeGate, sentBack, sideGate("device-confirm"), sideGate("after-stages"), landPrWorkflow()],
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
  return { server, github, actionsDir, runId, gateId, pr, store: () => fixture.routes.shepherd!.store.get() };
}

/** Registers the world's PR under its own run, with the holds given placed in order. */
function holdPr(w: World, ...holds: string[]): void {
  w.store().register({ repo: REPO, pr: w.pr, runId: HELD_RUN, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  for (const reason of holds) w.store().hold(HELD_RUN, reason);
}

/** The console's record for a confirmed owner-release tap; returns the confirm event its bytes stand for. */
function writeRelease(w: World, action: Record<string, unknown> = {}, actionId = ACTION_ID): string {
  const record = JSON.stringify({ id: actionId, itemId: `hold:${REPO}#${w.pr}`, action: { kind: "owner-release", repo: REPO, pr: w.pr, headSha: H, ...action }, at: new Date(NOW_MS).toISOString() });
  writeFileSync(join(w.actionsDir, `${actionId}.json`), record, { mode: 0o600 });
  return `action:${createHash("sha256").update(record).digest("hex")}`;
}

const releases = (w: World) => w.store().eventsOf(HELD_RUN).filter((event) => event.kind === "release");

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
    writeRecord(w, { decision: 7 }, "misshapen");

    const outcomes = await Promise.all(["linked", "dir", "big", "misshapen"].map(async (actionId) => reply(await post(w.server, { actionId }))));

    expect(outcomes).toMatchObject([
      [422, { outcome: "refused", reason: "record-unreadable" }],
      [422, { outcome: "refused", reason: "record-unreadable", detail: expect.stringContaining("not a regular file") }],
      [422, { outcome: "refused", reason: "record-unreadable", detail: expect.stringContaining("over") }],
      [422, { outcome: "refused", reason: "record" }],
    ]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("refuses a record that asks for a waive-proof, a decided one included: the console tap waives no fix-proof", async () => {
    const w = await world();
    writeRecord(w, { stepId: "sh-sent-back", decision: "waive-proof" }, "waive");
    writeRecord(w, { stepId: "sh-sent-back", decision: "waive-proof", provenance: "decided" }, "waive-decided");

    const outcomes = await Promise.all(["waive", "waive-decided"].map(async (actionId) => reply(await post(w.server, { actionId }))));

    expect(outcomes).toMatchObject([
      [422, { outcome: "refused", reason: "record" }],
      [422, { outcome: "refused", reason: "record" }],
    ]);
    expect(w.store().proofWaivers().waivedAt(w.runId, H)).toBe(false);
  });

  it("takes only {actionId} in the body, and rejects an id that climbs out of the actions dir and a body over the cap", async () => {
    const w = await world();
    writeRecord(w);

    const extra = await post(w.server, { actionId: ACTION_ID, gateId: w.gateId });
    const climbing = await post(w.server, { actionId: `../actions/${ACTION_ID}` });
    const oversize = await post(w.server, { actionId: ACTION_ID, pad: "x".repeat(MAX_ACTION_BODY_BYTES) });

    expect([extra.status, climbing.status, oversize.status]).toEqual([400, 400, 413]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("resolves once under a concurrent double post of one record: the other reads already", async () => {
    const w = await world();
    writeRecord(w);

    const responses = await Promise.all([post(w.server, { actionId: ACTION_ID }), post(w.server, { actionId: ACTION_ID })]);

    const outcomes = await Promise.all(responses.map(async (res) => z.object({ outcome: z.string() }).parse(await res.json()).outcome));
    expect(outcomes.sort()).toEqual(["already", "resolved"]);
  });

  it("refuses with 403 class an approve-merge record asking abandon or send-back, leaving the gate pending", async () => {
    const w = await world();
    writeRecord(w, { decision: "abandon" }, "abandon");
    writeRecord(w, { decision: "send-back" }, "send-back");

    const outcomes = await Promise.all(["abandon", "send-back"].map(async (actionId) => reply(await post(w.server, { actionId }))));

    expect(outcomes).toMatchObject([
      [403, { outcome: "refused", reason: "class" }],
      [403, { outcome: "refused", reason: "class" }],
    ]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  describe("sh-sent-back", () => {
    /** Opens a sent-back gate on the world's PR and writes the console's record for it. */
    async function sentBackWorld(params: Record<string, string> = {}): Promise<World & { sentBackId: string; record: (action?: Record<string, unknown>, actionId?: string) => string }> {
      const w = await world();
      const runId = w.server.host.runtime.start("sent-back-gate", { pr: String(w.pr), ...params });
      const sentBackId = `${runId}/sh-sent-back`;
      await vi.waitFor(() => expect(w.server.host.gates.get(sentBackId)?.status).toBe("pending"));
      const record = (action: Record<string, unknown> = {}, actionId = ACTION_ID) => writeRecord(w, { gateId: sentBackId, runId, stepId: "sh-sent-back", decision: "await-new-head", ...action }, actionId);
      return { ...w, runId, sentBackId, record };
    }

    it("resolves await-new-head with the decision alone, as owner-remote from the console inbox bound to the record's sha256", async () => {
      const w = await sentBackWorld();
      const confirmEvent = w.record();

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toEqual([200, { outcome: "resolved", gateId: w.sentBackId }]);
      const gate = w.server.host.gates.get(w.sentBackId);
      expect(gate?.payload).toEqual({ decision: "await-new-head" });
      expect(gate?.resolvedBy).toEqual({ class: "owner-remote", id: "titan-console", channel: "console:inbox", confirmEvent });
    });

    it("refuses with 403 class a record asking abandon, which the gate's schema offers, leaving the gate pending", async () => {
      const w = await sentBackWorld();
      w.record({ decision: "abandon" });

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toMatchObject([403, { outcome: "refused", reason: "class", detail: expect.stringContaining("abandon") }]);
      expect(w.server.host.gates.get(w.sentBackId)?.status).toBe("pending");
    });

    it("refuses with 403 class an await-new-head the gate's own schema does not offer", async () => {
      const w = await sentBackWorld({ decisions: "abandon" });
      w.record();

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toMatchObject([403, { outcome: "refused", reason: "class" }]);
      expect(w.server.host.gates.get(w.sentBackId)?.status).toBe("pending");
    });

    it("answers 409 moved with the gate's head when the record and GitHub name a head the gate does not ask about, and leaves the gate pending", async () => {
      const w = await sentBackWorld();
      w.github.pushHead(w.pr, H2);
      w.record({ headSha: H2 });

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toEqual([409, { outcome: "moved", currentHead: H }]);
      expect(w.server.host.gates.get(w.sentBackId)?.status).toBe("pending");
    });
  });

  describe("owner-release", () => {
    it("lifts the owner-asked hold at the head as owner-remote from the console inbox, bound to the record's sha256", async () => {
      const w = await world();
      holdPr(w, OWNER);
      const confirmEvent = writeRelease(w);

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toEqual([200, { outcome: "released", runId: HELD_RUN, stillHeld: null }]);
      expect(w.store().byRun(HELD_RUN)).toMatchObject({ held: false, ownerHold: null });
      expect(releases(w).map((event) => [event.reason, event.actor, event.headSha])).toEqual([[OWNER, `owner-remote:titan-console proof ${confirmEvent}`, H]]);
    });

    it("lifts only the owner's hold and reports the hold still in force", async () => {
      const w = await world();
      holdPr(w, OWNER, G10);
      writeRelease(w);

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toEqual([200, { outcome: "released", runId: HELD_RUN, stillHeld: G10 }]);
      expect(w.store().byRun(HELD_RUN)).toMatchObject({ held: true, holdReason: G10, ownerHold: null });
    });

    it("answers 410 gone for a PR with no owner-asked hold and for an unregistered PR, leaving any other hold alone", async () => {
      const w = await world();
      writeRelease(w, {}, "act-unregistered");
      const unregistered = await post(w.server, { actionId: "act-unregistered" });
      holdPr(w, G10);
      writeRelease(w);

      const notHeld = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(unregistered)).toMatchObject([410, { outcome: "gone", reason: expect.stringContaining("not registered") }]);
      expect(await reply(notHeld)).toMatchObject([410, { outcome: "gone", reason: expect.stringContaining("holds no owner-asked hold") }]);
      expect(w.store().byRun(HELD_RUN)).toMatchObject({ held: true, holdReason: G10 });
      expect(releases(w)).toEqual([]);
    });

    it("answers 409 moved with GitHub's head when the PR moved past the record's head, and keeps the hold", async () => {
      const w = await world();
      holdPr(w, OWNER);
      writeRelease(w);
      w.github.pushHead(w.pr, H2);

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toEqual([409, { outcome: "moved", currentHead: H2 }]);
      expect(w.store().byRun(HELD_RUN)?.ownerHold).toMatchObject({ reason: OWNER });
      expect(releases(w)).toEqual([]);
    });

    it("answers 409 moved with GitHub's head when the PR moves during the release itself, and keeps the hold", async () => {
      const w = await world();
      holdPr(w, OWNER);
      writeRelease(w);
      const read = w.github.wire.getPr.bind(w.github.wire);
      vi.spyOn(w.github.wire, "getPr").mockImplementationOnce(async (...args) => {
        const before = await read(...args);
        w.github.pushHead(w.pr, H2);
        return before;
      });

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toEqual([409, { outcome: "moved", currentHead: H2 }]);
      expect(w.store().byRun(HELD_RUN)?.ownerHold).toMatchObject({ reason: OWNER });
      expect(releases(w)).toEqual([]);
    });

    it("still answers 410 gone when the owner-asked hold is lifted during the release itself", async () => {
      const w = await world();
      holdPr(w, OWNER);
      writeRelease(w);
      const read = w.github.wire.getPr.bind(w.github.wire);
      vi.spyOn(w.github.wire, "getPr").mockImplementationOnce(async (...args) => {
        w.store().releaseOwnerHold(HELD_RUN, { actor: "owner-terminal:synthetic", headSha: H });
        return read(...args);
      });

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toMatchObject([410, { outcome: "gone", reason: expect.stringContaining("holds no owner-asked hold") }]);
    });

    it("refuses a record that names a coordinator resolver, and keeps the hold", async () => {
      const w = await world();
      holdPr(w, OWNER);
      writeRelease(w, { resolver: { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" } });

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toMatchObject([422, { outcome: "refused", reason: "record" }]);
      expect(w.store().byRun(HELD_RUN)?.ownerHold).toMatchObject({ reason: OWNER });
      expect(releases(w)).toEqual([]);
    });

    it("reads a replayed action id as already, and another record after it as gone", async () => {
      const w = await world();
      holdPr(w, OWNER);
      writeRelease(w);
      await post(w.server, { actionId: ACTION_ID });
      writeRelease(w, {}, "act-2");

      const replay = await post(w.server, { actionId: ACTION_ID });
      const other = await post(w.server, { actionId: "act-2" });

      expect(await reply(replay)).toEqual([200, { outcome: "already", runId: HELD_RUN }]);
      expect(await reply(other)).toMatchObject([410, { outcome: "gone" }]);
      expect(releases(w)).toHaveLength(1);
    });

    it("reads a replay after the owner held the PR again as already, and keeps the newer hold", async () => {
      const w = await world();
      holdPr(w, OWNER);
      writeRelease(w);
      await post(w.server, { actionId: ACTION_ID });
      w.store().hold(HELD_RUN, OWNER);

      const replay = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(replay)).toEqual([200, { outcome: "already", runId: HELD_RUN }]);
      expect(w.store().byRun(HELD_RUN)?.ownerHold).toMatchObject({ reason: OWNER });
      expect(releases(w)).toHaveLength(1);
    });

    it("releases once under a concurrent double post of one record: the other reads already", async () => {
      const w = await world();
      holdPr(w, OWNER);
      writeRelease(w);

      const responses = await Promise.all([post(w.server, { actionId: ACTION_ID }), post(w.server, { actionId: ACTION_ID })]);

      const outcomes = await Promise.all(responses.map(async (res) => z.object({ outcome: z.string() }).parse(await res.json()).outcome));
      expect(outcomes.sort()).toEqual(["already", "released"]);
      expect(releases(w)).toHaveLength(1);
    });
  });

  describe("owner ops", () => {
    /** The console's record for a confirmed owner-op tap. */
    function writeOp(w: World, op: Record<string, unknown>, extra: Record<string, unknown> = {}, actionId = ACTION_ID): void {
      const record = JSON.stringify({ id: actionId, itemId: `pr:${REPO}#${w.pr}@${H}`, op, ...extra, at: new Date(NOW_MS).toISOString() });
      writeFileSync(join(w.actionsDir, `${actionId}.json`), record, { mode: 0o600 });
    }

    const ledgerWritten = (w: World) => existsSync(join(dirname(w.actionsDir), OWNER_OPS_LEDGER));

    it("refuses with 422 record an op of a kind the factory does not know", async () => {
      const w = await world();
      writeOp(w, { kind: "run-shell", command: "synthetic" });

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toMatchObject([422, { outcome: "refused", reason: "record", detail: expect.stringContaining("names no owner op") }]);
      expect(ledgerWritten(w)).toBe(false);
    });

    it("refuses with 403 class an op the factory has no effect for, logging nothing", async () => {
      const w = await world();
      writeOp(w, { kind: "factory-config-set", path: "shepherd.gateReset.heldRepair", value: "on" });

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toMatchObject([403, { outcome: "refused", reason: "class", detail: expect.stringContaining("no factory effect") }]);
      expect(ledgerWritten(w)).toBe(false);
    });

    it("answers 200 accepted for a merge-at-head with no Shepherd gate, starting one land-pr that never updates the branch", async () => {
      const w = await world();
      writeOp(w, { kind: "merge-at-head", repo: REPO, pr: w.pr, headSha: H });

      const res = await post(w.server, { actionId: ACTION_ID });

      const [status, body] = await reply(res);
      const lands = w.server.host.runtime.list().filter((run) => run.workflowName === "land-pr");
      expect([status, body]).toEqual([200, { outcome: "accepted", runId: lands[0]?.id }]);
      expect(lands.map((run) => run.params)).toEqual([{ repo: REPO, pr: String(w.pr), update: "false" }]);
      expect(ledgerWritten(w)).toBe(true);
      expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
    });

    it("reads a record that names both an action and an op as the action alone, as before ops existed", async () => {
      const w = await world();
      const action = { kind: "resolve-gate", gateId: w.gateId, runId: w.runId, stepId: "approve-merge", repo: REPO, pr: w.pr, headSha: H, decision: "merge" };
      writeOp(w, { kind: "close-pr", repo: REPO, pr: w.pr, headSha: H }, { action });

      const res = await post(w.server, { actionId: ACTION_ID });

      expect(await reply(res)).toEqual([200, { outcome: "resolved", gateId: w.gateId }]);
      expect(ledgerWritten(w)).toBe(false);
    });
  });

  it("is no registry command, and so no MCP tool", () => {
    const names = createFactoryRegistry().list().map((cmd) => cmd.name);

    expect(names.filter((name) => /console|action/i.test(name))).toEqual([]);
  });
});

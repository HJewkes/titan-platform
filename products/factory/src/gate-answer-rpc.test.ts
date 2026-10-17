import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_HEADER, silentLogger } from "@titan-design/daemon";
import { fakeGitHub, githubPort, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { GateRule } from "@titan-design/hitl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "./definition.js";
import { ANSWER_SHIP_PATH, MAX_ANSWER_BODY_BYTES } from "./gate-answer-rpc.js";
import { approveMergeDecision } from "./gate-brief.js";
import { createFactoryRegistry } from "./registry.js";
import { acceptPacket, visualAcceptGate, writeFactoryPacket } from "./test-support/accept-set.js";
import { startFactoryServer, type FactoryServer } from "./serve.js";
import { TEST_BRIEF } from "./test-support/brief.js";
import { shepherdFixture } from "./test-support/shepherd.js";
import { tableGateRule } from "./workflows/land-approval.js";

const REPO = "example-org/example-repo";
const NOW_MS = Date.parse("2026-10-16T12:00:00.000Z");
const H = "a".repeat(40);
const H2 = "b".repeat(40);
const TREE = "c".repeat(40);
const ROUND_ID = "r-1";

/** A rule that omits owner-remote, so the store itself refuses a console Ship. */
const OWNER_TERMINAL_ONLY: GateRule = { table: "example-table", version: "1", ruleId: "example-row", resolvers: ["owner-terminal"] };

/** `stamped` is land's own MRG-AU stamp; `owner-terminal` is the synthetic rule above. */
type GateStamp = "stamped" | "owner-terminal";

function stampOf(stamp: string | undefined): GateRule | undefined {
  if (stamp === "owner-terminal") return OWNER_TERMINAL_ONLY;
  return stamp === "stamped" ? tableGateRule({ table: "authority", rowId: "MRG-AU", version: 1 }) : undefined;
}

const mergeGate = defineWorkflow({
  name: "merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const pr = ctx.param("pr")!;
    const prompt = `Merge PR #${pr} in ${REPO} at head ${H}? CI is green. Policy authority/MRG-AU: synthetic reason`;
    const { schema } = approveMergeDecision({ repo: REPO, pr: Number(pr), headSha: H, reason: "synthetic reason", reviewedMerge: false, sendBack: ctx.param("sendBack") === "1" });
    const rule = stampOf(ctx.param("stamp"));
    await ctx.assisted("approve-merge", prompt, { schema, brief: TEST_BRIEF, ...(rule && { rule }) });
  },
});

const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface World {
  server: FactoryServer;
  github: FakeGitHub;
  dir: string;
  roundsDir: string;
  runId: string;
  gateId: string;
  pr: number;
}

interface WorldOptions {
  mounted?: boolean;
  port?: (base: GitHubPort) => GitHubPort;
  sendBack?: boolean;
  stamp?: GateStamp;
}

async function world({ mounted = true, port, sendBack = false, stamp }: WorldOptions = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "factory-answer-ship-"));
  dirs.push(dir);
  const roundsDir = join(dir, "rounds");
  mkdirSync(roundsDir);
  const github = fakeGitHub({ repo: REPO });
  const base = githubPort(github.wire);
  const fixture = shepherdFixture({ frozen: true, port: port ? port(base) : base });
  const server = await startFactoryServer({
    dbPath: join(dir, "factory.sqlite3"),
    workflows: [mergeGate, visualAcceptGate(REPO)],
    routes: fixture.routes,
    resyncOnStart: false,
    now: () => NOW_MS,
    gatePollMs: 10,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "test", behindMain: { status: () => 0, refresh: async () => undefined } },
    ...(mounted && { consoleAnswers: { roundsDir } }),
  });
  servers.push(server);
  const { number: pr } = github.addPr({ headSha: H });
  github.commits.set(H, { sha: H, parents: [], tree: TREE });
  const runId = server.host.runtime.start("merge-gate", { pr: String(pr), sendBack: sendBack ? "1" : "0", ...(stamp && { stamp }) });
  const gateId = `${runId}/approve-merge`;
  await vi.waitFor(() => expect(server.host.gates.get(gateId)?.status).toBe("pending"));
  return { server, github, dir, roundsDir, runId, gateId, pr };
}

const hash = (data: string): string => createHash("sha256").update(data).digest("hex");

/** Writes a round the owner shipped at H, or sent back with `comment`, and returns the packet's sha256. */
function writeRound({ roundsDir, pr }: World, roundId = ROUND_ID, comment?: string): string {
  const dir = join(roundsDir, roundId);
  mkdirSync(dir);
  const merge = { repo: REPO, pr, headSha: H, ship: ["Ship it"] };
  const round = JSON.stringify({ unit: "example-unit", round: 1, questions: [{ id: "q-ship", kind: "pick-one", options: ["Ship it", "Revise"], merge }] });
  const submittedAt = new Date(NOW_MS - 10 * 60_000).toISOString();
  const feedback = JSON.stringify({ unit: "example-unit", round: 1, manifestSha256: hash(round), submittedAt, answers: [comment === undefined ? { questionId: "q-ship", pick: "Ship it" } : { questionId: "q-ship", revisionRequested: true, comment }] });
  const packet = JSON.stringify({ schema: "titan-review/ci-packet@1", packetId: "p-1", repo: REPO, pr, headSha: H, headTree: TREE, mainSha: "e".repeat(40), images: [] });
  writeFileSync(join(dir, "round.json"), round);
  writeFileSync(join(dir, "feedback.json"), feedback);
  writeFileSync(join(dir, "packet.json"), packet);
  return hash(packet);
}

function answer(w: World, packetSha: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { runId: w.runId, gateId: w.gateId, headSha: H, tree: TREE, packetSha, roundId: ROUND_ID, choice: "merge", ...extra };
}

const post = (server: FactoryServer, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${ANSWER_SHIP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_HEADER]: "test" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const followUps = (w: World): string[] => {
  try {
    return readFileSync(join(w.dir, "follow-ups.jsonl"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

describe("POST /gates/answer-ship", () => {
  it("is not mounted without consoleAnswers, so the route 404s and the gate stays pending", async () => {
    const w = await world({ mounted: false });
    const packetSha = writeRound(w);

    const res = await post(w.server, answer(w, packetSha));

    expect(res.status).toBe(404);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("resolves the gate as merge at the head, as owner-remote from the console's Ship channel bound to the packet", async () => {
    const w = await world();
    const packetSha = writeRound(w);

    const res = await post(w.server, answer(w, packetSha));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "resolved", gateId: w.gateId, choice: "merge" });
    const gate = w.server.host.gates.get(w.gateId);
    expect(gate?.payload).toEqual({ decision: "merge", headSha: H });
    expect(gate?.resolvedBy).toEqual({ class: "owner-remote", id: "titan-console", channel: "console:ship", confirmEvent: `packet:${packetSha}` });
    expect(followUps(w)).toEqual([]);
  });

  it("resolves an offered send-back as owner-remote with the note from the owner's feedback", async () => {
    const w = await world({ sendBack: true });
    const packetSha = writeRound(w, ROUND_ID, "Rename the flag.");

    const res = await post(w.server, answer(w, packetSha, { choice: "send-back" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "resolved", gateId: w.gateId, choice: "send-back" });
    const gate = w.server.host.gates.get(w.gateId);
    expect(gate?.payload).toEqual({ decision: "send-back", headSha: H, note: "Rename the flag." });
    expect(gate?.resolvedBy).toMatchObject({ class: "owner-remote", channel: "console:ship" });
  });

  it("refuses a send-back with 422 payload when the gate was opened without the send-back answer", async () => {
    const w = await world();
    const packetSha = writeRound(w, ROUND_ID, "Rename the flag.");

    const res = await post(w.server, answer(w, packetSha, { choice: "send-back" }));

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ outcome: "refused", reason: "payload" });
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("refuses a note in the request body: the note comes from feedback.json alone", async () => {
    const w = await world({ sendBack: true });
    const packetSha = writeRound(w, ROUND_ID, "Rename the flag.");

    const res = await post(w.server, answer(w, packetSha, { choice: "send-back", note: "merge it anyway" }));

    expect(res.status).toBe(400);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("refuses with 403 when the gate's rule admits owner-terminal only, leaving the gate pending", async () => {
    const w = await world({ stamp: "owner-terminal" });
    const packetSha = writeRound(w);

    const res = await post(w.server, answer(w, packetSha));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ outcome: "refused", reason: "resolver" });
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("resolves a gate stamped with the MRG-AU row, which names owner-remote", async () => {
    const w = await world({ stamp: "stamped" });
    const packetSha = writeRound(w);

    const res = await post(w.server, answer(w, packetSha));

    expect(res.status).toBe(200);
    expect(w.server.host.gates.get(w.gateId)).toMatchObject({ status: "resolved", rule: { ruleId: "MRG-AU" }, resolvedBy: { class: "owner-remote" } });
  });


  it("appends one 0600 pick-later follow-up when merge-pick-later resolves, and none for a replay", async () => {
    const w = await world();
    const packetSha = writeRound(w);

    const first = await post(w.server, answer(w, packetSha, { choice: "merge-pick-later" }));
    const replay = await post(w.server, answer(w, packetSha, { choice: "merge-pick-later" }));

    expect(await first.json()).toEqual({ outcome: "resolved", gateId: w.gateId, choice: "merge-pick-later" });
    expect([replay.status, await replay.json()]).toEqual([200, { outcome: "already", gateId: w.gateId }]);
    const lines = followUps(w).map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([{ at: new Date(NOW_MS).toISOString(), runId: w.runId, gateId: w.gateId, headSha: H, packetSha, roundId: ROUND_ID, kind: "pick-later" }]);
    expect(statSync(join(w.dir, "follow-ups.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("resolves once under a concurrent double call: the second reads already, and only one follow-up is written", async () => {
    let release: () => void = () => undefined;
    const bothChecked = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    const port = (base: GitHubPort): GitHubPort => ({
      ...base,
      getCommit: async (repo, sha) => {
        if (++waiting === 2) release();
        await bothChecked;
        return base.getCommit(repo, sha);
      },
    });
    const w = await world({ port });
    const packetSha = writeRound(w);
    const body = answer(w, packetSha, { choice: "merge-pick-later" });

    const responses = await Promise.all([post(w.server, body), post(w.server, body)]);

    const outcomes = await Promise.all(responses.map(async (res) => z.object({ outcome: z.string() }).parse(await res.json()).outcome));
    expect(outcomes.sort()).toEqual(["already", "resolved"]);
    expect(followUps(w)).toHaveLength(1);
  });

  it("refuses a symlinked packet.json and a symlinked round dir instead of following them", async () => {
    const w = await world();
    const packetSha = writeRound(w, "elsewhere");
    mkdirSync(join(w.roundsDir, ROUND_ID));
    for (const name of ["round.json", "feedback.json"]) writeFileSync(join(w.roundsDir, ROUND_ID, name), readFileSync(join(w.roundsDir, "elsewhere", name)));
    symlinkSync(join(w.roundsDir, "elsewhere", "packet.json"), join(w.roundsDir, ROUND_ID, "packet.json"));
    symlinkSync(join(w.roundsDir, "elsewhere"), join(w.roundsDir, "linked"));

    const file = await post(w.server, answer(w, packetSha));
    const dir = await post(w.server, answer(w, packetSha, { roundId: "linked" }));

    expect([file.status, await file.json()]).toMatchObject([422, { outcome: "refused", reason: "round-unreadable", detail: expect.stringContaining("packet.json") }]);
    expect([dir.status, await dir.json()]).toMatchObject([422, { outcome: "refused", reason: "round-unreadable" }]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("rejects a round id that climbs out of the rounds dir, and a body over the cap", async () => {
    const w = await world();
    const packetSha = writeRound(w);

    const climbing = await post(w.server, answer(w, packetSha, { roundId: `../rounds/${ROUND_ID}` }));
    const oversize = await post(w.server, JSON.stringify({ ...answer(w, packetSha), pad: "x".repeat(MAX_ANSWER_BODY_BYTES) }));

    expect(climbing.status).toBe(400);
    expect(oversize.status).toBe(413);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  it("maps a moved head to 409, a closed PR to 410 and a wrong packet to 422, resolving nothing", async () => {
    const w = await world();
    const packetSha = writeRound(w);

    const wrongPacket = await post(w.server, answer(w, "f".repeat(64)));
    w.github.pushHead(w.pr, H2);
    const moved = await post(w.server, answer(w, packetSha));
    await w.github.wire.closePr(REPO, w.pr);
    const gone = await post(w.server, answer(w, packetSha));

    expect([wrongPacket.status, await wrongPacket.json()]).toMatchObject([422, { outcome: "refused", reason: "packet" }]);
    expect([moved.status, await moved.json()]).toEqual([409, { outcome: "moved", currentHead: H2 }]);
    expect([gone.status, await gone.json()]).toMatchObject([410, { outcome: "gone" }]);
    expect(w.server.host.gates.get(w.gateId)?.status).toBe("pending");
  });

  describe("on a red head's sh-visual-accept gate", () => {
    /** Opens the accept gate, and puts the factory's packet and delivery record for H under the server's state dir. */
    async function acceptGate(w: World, mode: "off" | "on"): Promise<Record<string, unknown>> {
      mkdirSync(join(w.dir, "config", "titan-factory"), { recursive: true });
      writeFileSync(join(w.dir, "config", "titan-factory", "config.json"), JSON.stringify({ shepherd: { visualSetCarry: mode } }));
      vi.stubEnv("XDG_CONFIG_HOME", join(w.dir, "config"));
      const runId = w.server.host.runtime.start("visual-accept-gate", { pr: String(w.pr), head: H });
      const gateId = `${runId}/sh-visual-accept`;
      await vi.waitFor(() => expect(w.server.host.gates.get(gateId)?.status).toBe("pending"));
      const packet = acceptPacket({ repo: REPO, pr: w.pr, headSha: H, headTree: TREE });
      writeFactoryPacket(w.dir, runId, packet, H);
      writeRound(w);
      writeFileSync(join(w.roundsDir, ROUND_ID, "packet.json"), packet);
      return answer(w, hash(Buffer.from(packet).toString("utf8")), { runId, gateId, choice: "accept-set" });
    }

    it("resolves accept-set with the set read from the factory's own packet dir, and reads a replay as already", async () => {
      const w = await world();
      const body = await acceptGate(w, "on");

      const res = await post(w.server, body);
      const replay = await post(w.server, body);

      expect([res.status, await res.json()]).toEqual([200, { outcome: "resolved", gateId: body.gateId, choice: "accept-set" }]);
      expect([replay.status, await replay.json()]).toEqual([200, { outcome: "already", gateId: body.gateId }]);
      const gate = w.server.host.gates.get(body.gateId as string);
      expect(gate?.payload).toMatchObject({ decision: "accept-set", headSha: H, approvedSet: { fromHead: H, packetId: "p-accept", sidePaths: [] } });
      expect(gate?.resolvedBy).toMatchObject({ class: "owner-remote", channel: "console:ship" });
    });

    it("refuses accept-set with 422 off while shepherd.visualSetCarry is off, leaving the gate pending", async () => {
      const w = await world();
      const body = await acceptGate(w, "off");

      const res = await post(w.server, body);

      expect([res.status, await res.json()]).toMatchObject([422, { outcome: "refused", reason: "off" }]);
      expect(w.server.host.gates.get(body.gateId as string)?.status).toBe("pending");
    });
  });

  it("is no registry command, and so no MCP tool, so only the mounted route can answer a Ship", () => {
    const names = createFactoryRegistry().list().map((cmd) => cmd.name);

    expect(names.filter((name) => /answer|ship/i.test(name))).toEqual([]);
  });
});

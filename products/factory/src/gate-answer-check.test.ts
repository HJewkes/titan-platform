import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import { GATE_CANCELLED_SIGNAL } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "./definition.js";
import { checkAnswer, type AnswerRequest } from "./gate-answer-check.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { TEST_BRIEF } from "./test-support/brief.js";

const REPO = "example-org/example-repo";
const sha = (char: string): string => char.repeat(40);
const H = sha("a");
const H2 = sha("b");
const TREE = sha("c");
const TREE2 = sha("d");
const NOW = new Date("2026-10-16T12:00:00.000Z");
const MINUTE = 60_000;
const OWNER = { class: "owner-terminal" as const, id: "owner", channel: "test" };

/** The head each PR's run asks about next; a run re-asks after a cancel unless its PR is listed in `settleOnCancel`. */
const askedHead = new Map<string, string>();
const settleOnCancel = new Set<string>();

const mergeGate = defineWorkflow({
  name: "merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const pr = ctx.param("pr")!;
    for (;;) {
      const head = askedHead.get(pr)!;
      const prompt = `Merge PR #${pr} in ${REPO} at head ${head}? CI is green. Policy authority/MRG-AU: synthetic reason`;
      const schema = z.object({ decision: z.enum(["merge", "abandon"]), headSha: z.literal(head) });
      const answer = await ctx.assisted("approve-merge", prompt, { schema, brief: TEST_BRIEF, recordCancel: true });
      if (answer.signal !== GATE_CANCELLED_SIGNAL || settleOnCancel.has(pr)) return;
    }
  },
});

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  askedHead.clear();
  settleOnCancel.clear();
});

interface World {
  host: FactoryHost;
  github: FakeGitHub;
  runId: string;
  gateId: string;
  pr: number;
}

async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "factory-gate-answer-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [mergeGate], routes: [], gatePollMs: 10 });
  hosts.push(host);
  const github = fakeGitHub({ repo: REPO });
  const { number: pr } = github.addPr({ headSha: H });
  github.commits.set(H, { sha: H, parents: [], tree: TREE });
  askedHead.set(String(pr), H);
  const runId = host.runtime.start("merge-gate", { pr: String(pr) });
  const gateId = `${runId}/approve-merge`;
  await vi.waitFor(() => expect(host.gates.get(gateId)?.status).toBe("pending"));
  return { host, github, runId, gateId, pr };
}

/** Cancels the gate as a 418 head-move sweep does; the run asks again at `head` as gate `:1` unless it settles. */
async function supersede({ host, gateId, pr }: World, head: string, { reask = true } = {}): Promise<void> {
  askedHead.set(String(pr), head);
  if (!reask) settleOnCancel.add(String(pr));
  host.gates.cancel(gateId, `superseded: the pull request moved to ${head}`);
  if (reask) await vi.waitFor(() => expect(host.gates.get(`${gateId}:1`)?.status).toBe("pending"));
}

const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const hash = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

interface RoundOptions {
  boundHead?: string;
  pick?: string;
  revisionRequested?: boolean;
  ageMs?: number;
  manifestSha256?: string;
  packet?: Record<string, unknown>;
}

function roundFiles(pr: number, options: RoundOptions = {}) {
  const merge = { repo: REPO, pr, headSha: options.boundHead ?? H, ship: ["Ship it"] };
  const round = bytes({ unit: "example-unit", round: 1, questions: [{ id: "q-ship", kind: "pick-one", options: ["Ship it", "Revise"], merge }] });
  const answer = { questionId: "q-ship", pick: options.pick ?? "Ship it", ...(options.revisionRequested ? { revisionRequested: true } : {}) };
  const submittedAt = new Date(NOW.getTime() - (options.ageMs ?? 10 * MINUTE)).toISOString();
  const feedback = bytes({ unit: "example-unit", round: 1, manifestSha256: options.manifestSha256 ?? hash(round), submittedAt, answers: [answer] });
  const packet = bytes({ schema: "titan-review/ci-packet@1", packetId: "p-1", repo: REPO, pr, headSha: H, headTree: TREE, mainSha: sha("e"), images: [], warnings: [], ...options.packet });
  return { round, feedback, packet };
}

function request({ runId, gateId }: World, files: { packet: Uint8Array }, extra: Partial<AnswerRequest> = {}): AnswerRequest {
  return { runId, gateId, headSha: H, tree: TREE, packetSha: hash(files.packet), roundId: "r-1", choice: "merge", ...extra };
}

async function check(w: World, options: RoundOptions = {}, extra: Partial<AnswerRequest> = {}) {
  const files = roundFiles(w.pr, options);
  return checkAnswer({ host: w.host, port: githubPort(w.github.wire), request: request(w, files, extra), files, now: NOW });
}

describe("checkAnswer", () => {
  it("resolves the request's gate as merge at the head when gate, GitHub, packet and feedback all agree", async () => {
    const w = await world();

    const outcome = await check(w);

    expect(outcome).toEqual({ kind: "resolve", gateId: w.gateId, choice: "merge", payload: { decision: "merge", headSha: H } });
  });

  it("resolves merge-pick-later with the same merge payload when the feedback ships", async () => {
    const w = await world();

    const outcome = await check(w, {}, { choice: "merge-pick-later" });

    expect(outcome).toMatchObject({ kind: "resolve", choice: "merge-pick-later", payload: { decision: "merge", headSha: H } });
  });

  it("reports moved with GitHub's head when the PR moved on GitHub though the gate still asks about the old head", async () => {
    const w = await world();
    w.github.pushHead(w.pr, H2);

    expect(await check(w)).toEqual({ kind: "moved", currentHead: H2 });
  });

  it("refuses tree-mismatch when GitHub's tree at the head differs from the tree the request and packet name", async () => {
    const w = await world();
    w.github.commits.set(H, { sha: H, parents: [], tree: TREE2 });

    expect(await check(w)).toMatchObject({ kind: "refused", reason: "tree-mismatch" });
  });

  it("reports moved and never answers the newer gate when the asked gate was cancelled and re-asked at the same head", async () => {
    const w = await world();
    await supersede(w, H);

    const outcome = await check(w);

    expect(outcome).toEqual({ kind: "moved", currentHead: H, waitsOn: `${w.gateId}:1` });
    expect(w.host.gates.get(`${w.gateId}:1`)?.status).toBe("pending");
  });

  it("reports moved to the newer gate's head when a 418 sweep cancelled the gate after a push", async () => {
    const w = await world();
    w.github.pushHead(w.pr, H2);
    await supersede(w, H2);

    expect(await check(w)).toEqual({ kind: "moved", currentHead: H2, waitsOn: `${w.gateId}:1` });
  });

  it("reports gone when the gate was cancelled and the run asks nothing more", async () => {
    const w = await world();
    await supersede(w, H, { reask: false });

    expect(await check(w)).toMatchObject({ kind: "gone" });
  });

  it("reports gone when the PR is already merged on GitHub", async () => {
    const w = await world();
    Object.assign(w.github.pr(w.pr), { state: "closed", merged: true });

    expect(await check(w)).toEqual({ kind: "gone", reason: `${REPO}#${w.pr} is merged on GitHub` });
  });

  it("reports already when the gate was resolved with this very answer", async () => {
    const w = await world();
    w.host.gates.resolve(w.gateId, { decision: "merge", headSha: H }, OWNER);

    expect(await check(w)).toEqual({ kind: "already", gateId: w.gateId });
  });

  it("reports gone when the gate was resolved with another answer", async () => {
    const w = await world();
    w.host.gates.resolve(w.gateId, { decision: "abandon", headSha: H }, OWNER);

    expect(await check(w)).toMatchObject({ kind: "gone" });
  });

  it("refuses a request whose packetSha is not the hash of packet.json", async () => {
    const w = await world();

    expect(await check(w, {}, { packetSha: "f".repeat(64) })).toMatchObject({ kind: "refused", reason: "packet" });
  });

  it.each([
    ["another head", { headSha: H2 }],
    ["another tree", { headTree: TREE2 }],
    ["another PR", { pr: 999 }],
  ])("refuses a packet that binds %s", async (_name, packet) => {
    const w = await world();

    expect(await check(w, { packet })).toMatchObject({ kind: "refused", reason: "packet" });
  });

  it.each([
    ["was written against another round.json", { manifestSha256: "0".repeat(64) }],
    ["is older than two hours", { ageMs: 3 * 60 * MINUTE }],
    ["shipped another head", { boundHead: H2 }],
  ])("refuses feedback that %s", async (_name, options) => {
    const w = await world();

    expect(await check(w, options)).toMatchObject({ kind: "refused", reason: "feedback" });
  });

  it("refuses choice when the request says merge but the owner's feedback asked for a revision", async () => {
    const w = await world();

    const outcome = await check(w, { pick: "Revise", revisionRequested: true });

    expect(outcome).toMatchObject({ kind: "refused", reason: "choice" });
  });

  it("refuses choice when the request says send-back but the owner's feedback shipped", async () => {
    const w = await world();

    expect(await check(w, {}, { choice: "send-back" })).toMatchObject({ kind: "refused", reason: "choice" });
  });

  it("refuses an agreed send-back until the gate offers that answer", async () => {
    const w = await world();

    const outcome = await check(w, { pick: "Revise", revisionRequested: true }, { choice: "send-back" });

    expect(outcome).toMatchObject({ kind: "refused", reason: "send-back-unsupported" });
  });

  it("refuses a gate id that belongs to another run", async () => {
    const w = await world();

    expect(await check(w, {}, { runId: "other-run" })).toMatchObject({ kind: "refused", reason: "unknown-gate" });
  });
});

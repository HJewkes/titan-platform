import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import { GATE_CANCELLED_SIGNAL } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "./definition.js";
import { MAX_NOTE_CHARS, checkAnswer, type AcceptFiles, type AnswerRequest } from "./gate-answer-check.js";
import { approveMergeDecision } from "./gate-brief.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { acceptPacket, afterDigests, visualAcceptGate } from "./test-support/accept-set.js";
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
      const { schema } = approveMergeDecision({ repo: REPO, pr: Number(pr), headSha: head, reason: "synthetic reason", reviewedMerge: false, sendBack: true });
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
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [mergeGate, visualAcceptGate(REPO)], routes: [], gatePollMs: 10 });
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
  general?: string;
  comment?: string;
  questionOptions?: string[];
}

function roundFiles(pr: number, options: RoundOptions = {}) {
  const merge = { repo: REPO, pr, headSha: options.boundHead ?? H, ship: ["Ship it"] };
  const round = bytes({ unit: "example-unit", round: 1, questions: [{ id: "q-ship", kind: "pick-one", options: options.questionOptions ?? ["Ship it", "Revise"], merge }] });
  const answer = { questionId: "q-ship", pick: options.pick ?? "Ship it", ...(options.revisionRequested ? { revisionRequested: true } : {}), ...(options.comment !== undefined && { comment: options.comment }) };
  const submittedAt = new Date(NOW.getTime() - (options.ageMs ?? 10 * MINUTE)).toISOString();
  const feedback = bytes({ unit: "example-unit", round: 1, manifestSha256: options.manifestSha256 ?? hash(round), submittedAt, answers: [answer, { questionId: "q-other", comment: "not about the merge" }], ...(options.general !== undefined && { general: options.general }) });
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

  it("reads the console's Send back, a pick of the one non-ship option with no revisionRequested, as a send-back with the comment as the note", async () => {
    const w = await world();

    const outcome = await check(w, { pick: "Revise", comment: "fix the gap" }, { choice: "send-back" });

    expect(outcome).toEqual({ kind: "resolve", gateId: w.gateId, choice: "send-back", payload: { decision: "send-back", headSha: H, note: "fix the gap" } });
  });

  it("refuses a send-back pick that is not one of the question's options", async () => {
    const w = await world();

    expect(await check(w, { pick: "Something else", comment: "fix the gap" }, { choice: "send-back" })).toMatchObject({ kind: "refused", reason: "feedback" });
  });

  it("refuses a non-ship pick on a question with two non-ship options", async () => {
    const w = await world();

    const outcome = await check(w, { pick: "Revise", comment: "fix the gap", questionOptions: ["Ship it", "Revise", "Park"] }, { choice: "send-back" });

    expect(outcome).toMatchObject({ kind: "refused", reason: "feedback" });
  });

  it("refuses choice when the request says send-back but the owner's feedback shipped", async () => {
    const w = await world();

    expect(await check(w, {}, { choice: "send-back" })).toMatchObject({ kind: "refused", reason: "choice" });
  });

  it("resolves an agreed send-back with the owner's general note, then the Ship question's comment, as the note", async () => {
    const w = await world();

    const outcome = await check(w, { pick: "Revise", revisionRequested: true, general: " Close, but not yet. ", comment: "Rename the flag." }, { choice: "send-back" });

    expect(outcome).toEqual({ kind: "resolve", gateId: w.gateId, choice: "send-back", payload: { decision: "send-back", headSha: H, note: "Close, but not yet.\n\nRename the flag." } });
  });

  it("cuts the owner's note at the cap the gate payload carries", async () => {
    const w = await world();

    const outcome = await check(w, { pick: "Revise", revisionRequested: true, general: "x".repeat(MAX_NOTE_CHARS + 10) }, { choice: "send-back" });

    expect(outcome).toMatchObject({ kind: "resolve", payload: { note: "x".repeat(MAX_NOTE_CHARS) } });
  });

  it("refuses a send-back whose feedback holds no words for the implementer", async () => {
    const w = await world();

    const outcome = await check(w, { pick: "Revise", revisionRequested: true, general: "  ", comment: "" }, { choice: "send-back" });

    expect(outcome).toMatchObject({ kind: "refused", reason: "feedback", detail: expect.stringContaining("no note") });
  });

  it("reports already when the gate was resolved with this very send-back", async () => {
    const w = await world();
    const options = { pick: "Revise", revisionRequested: true, comment: "Rename the flag." };
    w.host.gates.resolve(w.gateId, { decision: "send-back", headSha: H, note: "Rename the flag." }, OWNER);

    expect(await check(w, options, { choice: "send-back" })).toEqual({ kind: "already", gateId: w.gateId });
  });

  it("refuses a gate id that belongs to another run", async () => {
    const w = await world();

    expect(await check(w, {}, { runId: "other-run" })).toMatchObject({ kind: "refused", reason: "unknown-gate" });
  });
});

describe("checkAnswer on a red head's sh-visual-accept gate", () => {
  async function acceptWorld(): Promise<World> {
    const w = await world();
    const runId = w.host.runtime.start("visual-accept-gate", { pr: String(w.pr), head: H });
    const gateId = `${runId}/sh-visual-accept`;
    await vi.waitFor(() => expect(w.host.gates.get(gateId)?.status).toBe("pending"));
    return { ...w, runId, gateId };
  }

  const factoryPacket = (pr: number) => acceptPacket({ repo: REPO, pr, headSha: H, headTree: TREE });

  async function checkAccept(w: World, accept: Partial<AcceptFiles> = {}, options: RoundOptions = {}, extra: Partial<AnswerRequest> = {}) {
    const files = { ...roundFiles(w.pr, options), packet: factoryPacket(w.pr) };
    const factory = { packet: factoryPacket(w.pr), after: afterDigests(), delivery: bytes({ state: "delivered", packetId: "p-accept" }), ...accept };
    return checkAnswer({ host: w.host, port: githubPort(w.github.wire), request: request(w, files, { choice: "accept-set", ...extra }), files, accept: factory, now: NOW });
  }

  it("resolves Ship as accept-set with the set built from the factory's packet and a note that names its files", async () => {
    const w = await acceptWorld();

    const outcome = await checkAccept(w, {}, { comment: "Looks right." });

    expect(outcome).toMatchObject({ kind: "resolve", choice: "accept-set", payload: { decision: "accept-set", headSha: H, approvedSet: { fromHead: H, packetId: "p-accept", removed: ["c/gone.png"] } } });
    const note = outcome.kind === "resolve" && "note" in outcome.payload ? outcome.payload.note : "";
    expect(note).toMatch(/^Shepherd run .+: commit exactly[\s\S]*- write a\/one\.png[\s\S]*\n\nLooks right\.$/);
  });

  it("reads Don't ship on the accept gate as a send-back with the owner's note", async () => {
    const w = await acceptWorld();

    const outcome = await checkAccept(w, {}, { pick: "Revise", comment: "Wrong font." }, { choice: "send-back" });

    expect(outcome).toMatchObject({ kind: "resolve", payload: { decision: "send-back", headSha: H, note: "Wrong font." } });
  });

  it("refuses packet when the console's packet.json is not the factory's own copy", async () => {
    const w = await acceptWorld();

    expect(await checkAccept(w, { packet: acceptPacket({ repo: REPO, pr: w.pr, headSha: H, headTree: TREE2 }) })).toMatchObject({ kind: "refused", reason: "packet" });
  });

  it.each([
    ["names another packet", bytes({ state: "delivered", packetId: "p-other" })],
    ["is missing", undefined],
  ])("refuses packet-unbound when the delivery record %s", async (_name, delivery) => {
    const w = await acceptWorld();

    expect(await checkAccept(w, { delivery })).toMatchObject({ kind: "refused", reason: "packet-unbound" });
  });

  it("refuses choice for accept-set on approve-merge and for merge on the accept gate", async () => {
    const merge = await world();
    const accept = await acceptWorld();

    expect(await check(merge, {}, { choice: "accept-set" })).toMatchObject({ kind: "refused", reason: "choice" });
    expect(await checkAccept(accept, {}, {}, { choice: "merge" })).toMatchObject({ kind: "refused", reason: "choice" });
  });
});

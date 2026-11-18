import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { EXIT, invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { z } from "zod";
import type { ActionOutcome, OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { prTapCommands, type PrTapPrepareResult } from "./pr-tap.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const REPO = "acme/widgets";
const PR = 7;
const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const CLOSE = { kind: "close-pr", repo: REPO, pr: PR, headSha: HEAD } as const;
const MERGE = { kind: "merge-at-head", repo: REPO, pr: PR, headSha: HEAD } as const;
const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };

let dir: string;
let factory: FakeDaemon | undefined;
let previews: unknown[];
let liveHead: string | undefined;
let prState: "open" | "merged" | "closed";
let verdict: string;
let title: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-pr-tap-"));
  previews = [];
  title = "Add the widget";
  liveHead = HEAD;
  prState = "open";
  verdict = "allow";
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

const actionsDir = () => path.join(dir, "owner-actions");
const records = () => readdir(actionsDir()).catch(() => [] as string[]);

/** `owner-op.preview` as the factory answers a PR op: GitHub's live PR, with `head` only while it is open. */
function prPreview(kind: string) {
  return {
    kind,
    authority: { verdict, ruleId: "PR-OR", ...(verdict === "deny" && { reason: "the repo is frozen" }) },
    pr: { repo: REPO, pr: PR, state: prState, title, base: "main", ...(liveHead !== undefined && { head: liveHead }), behind: false, mergeableState: "clean", shepherd: null },
  };
}

/** The factory route as the console sees it: it answers `first` to the record's first post, and `already` to a replay. */
function spyFactory(first: ActionOutcome) {
  const posted: { actionId: string; bytes: string }[] = [];
  const client: OwnerActionClient = {
    post: async (actionId) => {
      const bytes = await readFile(path.join(actionsDir(), `${actionId}.json`), "utf8");
      posted.push({ actionId, bytes });
      return posted.length === 1 ? first : { status: "already", closedHead: HEAD };
    },
  };
  return { client, posted };
}

const ownerContext = (auth: RequestAuth | null = SESSION, ownerWrites = true): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth, ownerWrites });

async function harness(client: OwnerActionClient, enabled = true) {
  factory = await startFakeDaemon({ ok: true }, (command, args) => {
    if (command !== "owner-op.preview") throw new Error(`no fixture for ${command}`);
    const op = z.object({ kind: z.string() }).parse(args.op);
    previews.push(args.op);
    return prPreview(op.kind);
  });
  const commands = prTapCommands(shepherdReader(factory.port), { enabled, actionsDir: actionsDir(), client, now: () => 100_000 });
  return {
    prepare: async (target: object = CLOSE) => (await invokeCommand(commands["prTaps.prepare"], { target }, ownerContext())).envelope,
    act: (confirm: string, target: object = CLOSE, ctx = ownerContext()) => invokeCommand(commands["prTaps.act"], { target, confirm }, ctx),
  };
}

const ready = (envelope: JsonEnvelope<unknown>) => z.object({ ok: z.literal(true), data: z.custom<Extract<PrTapPrepareResult, { status: "ready" }>>((data) => z.object({ status: z.literal("ready") }).safeParse(data).success) }).parse(envelope).data;

describe("prTaps.prepare on a PR page", () => {
  it("reads an open PR back from the factory's preview with a confirm", async () => {
    const { prepare } = await harness(spyFactory({ status: "pr-closed", closedHead: HEAD }).client);

    const envelope = await prepare();

    expect(envelope).toMatchObject({ ok: true, data: { status: "ready", readBack: { repo: REPO, pr: PR, headSha: HEAD, title: "Add the widget", authority: "PR-OR: allow", proposedBy: "you", effect: expect.stringMatching(/^Close acme\/widgets#7 at aaaaaaa/) } } });
    expect(previews).toEqual([CLOSE]);
  });

  it.each([
    ["an authority deny", () => (verdict = "deny"), /authority table refuses a close-pr op to the console: the repo is frozen/],
    ["a closed PR", () => ((prState = "closed"), (liveHead = undefined)), /acme\/widgets#7 is closed on GitHub/],
    ["a head that moved past the one the page showed", () => (liveHead = NEW_HEAD), /moved to bbbbbbb/],
  ])("answers no-action for %s", async (_label, arrange, reason) => {
    arrange();
    const { prepare } = await harness(spyFactory({ status: "pr-closed", closedHead: HEAD }).client);

    expect(await prepare()).toMatchObject({ ok: true, data: { status: "no-action", reason: expect.stringMatching(reason) } });
  });

  it("answers that inbox actions are off when they are", async () => {
    const { prepare } = await harness(spyFactory({ status: "pr-closed", closedHead: HEAD }).client, false);

    expect(await prepare()).toMatchObject({ ok: false, error: expect.stringMatching(/inbox actions are off/) });
  });
});

describe("prTaps.act on a PR page", () => {
  it("writes a merge record pinned to the previewed head once and shows the accepted land run", async () => {
    const factorySpy = spyFactory({ status: "accepted", runId: "run-9" });
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare(MERGE));

    const { envelope } = await act(confirm, MERGE);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "accepted" }, message: "Merge queued: land run run-9 merges at this head once its checks are green" } });
    expect(JSON.parse(factorySpy.posted[0]!.bytes)).toMatchObject({ op: MERGE, readBack: { headSha: HEAD }, session: { issuedAt: 1_000 }, peer: "lan-remote" });
  });

  it("closes the PR and shows the closed head", async () => {
    const { prepare, act } = await harness(spyFactory({ status: "pr-closed", closedHead: HEAD }).client);
    const { confirm } = ready(await prepare());

    const { envelope } = await act(confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "pr-closed" }, message: "PR closed at aaaaaaa; its branch is kept" } });
    expect(JSON.parse(await readFile(path.join(actionsDir(), `${confirm}.outcome.json`), "utf8"))).toMatchObject({ status: "pr-closed", closedHead: HEAD });
  });

  it.each([
    ["the head moved", () => (liveHead = NEW_HEAD)],
    ["the title changed", () => (title = "Add the gadget")],
  ])("refuses the confirm when %s between prepare and act", async (_label, change) => {
    const factorySpy = spyFactory({ status: "pr-closed", closedHead: HEAD });
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare());
    change();

    const { envelope, exitCode } = await act(confirm);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/changed since it was read/) });
    expect(await records()).toEqual([]);
    expect(factorySpy.posted).toEqual([]);
  });

  it.each([
    ["loopback", ownerContext(null)],
    ["a bearer", ownerContext({ credential: "bearer", issuedAt: null, peerLocal: false })],
    ["a same-machine peer", ownerContext({ ...SESSION, peerLocal: true })],
    ["owner writes off", ownerContext(SESSION, false)],
  ])("refuses %s with no record and no post", async (_label, ctx) => {
    const factorySpy = spyFactory({ status: "pr-closed", closedHead: HEAD });
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare());

    const { envelope, exitCode } = await act(confirm, CLOSE, ctx);

    expect(exitCode).toBe(EXIT.NOPERM);
    expect(envelope.ok).toBe(false);
    expect(await records()).toEqual([]);
    expect(factorySpy.posted).toEqual([]);
  });

  it("reposts the identical record bytes on a replayed confirm and shows already", async () => {
    const factorySpy = spyFactory({ status: "pr-closed", closedHead: HEAD });
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare());
    await act(confirm);
    prState = "closed";
    liveHead = undefined;

    const { envelope } = await act(confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "already" }, message: "Already done by this confirmation" } });
    expect(factorySpy.posted.map((post) => post.bytes)).toEqual([factorySpy.posted[0]!.bytes, factorySpy.posted[0]!.bytes]);
  });
});

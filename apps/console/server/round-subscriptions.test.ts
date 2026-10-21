import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { importRoundCli } from "./cli-rounds.js";
import { subscriptionArgs, subscriptionCli } from "./cli-subscriptions.js";
import { resolveConfig } from "./config.js";
import { createRoundListeners, type ListenerDeps } from "./listeners.js";
import type { ConsoleContext } from "./owner-guard.js";
import { answerNotice } from "./round-asker.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { listSubscriptions, normalTarget, subscribe, subscriptionsDirOf, unsubscribe } from "./round-subscriptions.js";
import { roundsSubmitCommands } from "./rounds-submit.js";

// Synthetic: fixture rounds and made-up seat names only.
const DECISION = "kiln-schedule-r2";
const SHIP = "ship-tile-r1";
const IMPORT_FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "import", "sample-batch-r2");
const EARLIER = new Date("2026-10-20T11:00:00.000Z");
const NOW = new Date("2026-10-20T12:00:00.000Z");
const LATER = new Date("2026-10-20T13:00:00.000Z");

let root: string;
let roundsDir: string;
let subscriptionsDir: string;
let sent: { seat: string; text: string }[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-round-subscriptions-"));
  roundsDir = path.join(root, "state", "rounds");
  subscriptionsDir = subscriptionsDirOf(path.join(root, "state"));
  sent = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

const recordingNotify = async (seat: string, text: string): Promise<void> => {
  sent.push({ seat, text });
};

function listeners(overrides: Partial<ListenerDeps> = {}) {
  const unused = () => Promise.reject(new Error("no factory in this test"));
  return createRoundListeners({ enabled: false, roundsDir, subscriptionsDir, shepherd: { list: unused }, answer: { post: unused }, notify: recordingNotify, now: () => NOW, ...overrides });
}

async function placeRound(id: string): Promise<void> {
  await mkdir(path.join(roundsDir, id), { recursive: true });
  await cp(path.join(FIXTURE_ROUNDS.dir, id, "round.json"), path.join(roundsDir, id, "round.json"));
}

const feedbackPath = (id: string) => path.join(roundsDir, id, "feedback.json");

async function answer(id: string, at: Date, fields: { answers?: unknown[]; general?: string } = {}): Promise<void> {
  await writeFile(feedbackPath(id), JSON.stringify({ schema: "titan-review/feedback@1", answers: [], general: "", ...fields }));
  await utimes(feedbackPath(id), at, at);
}

const bySeat = (a: { seat: string }, b: { seat: string }) => a.seat.localeCompare(b.seat);

describe("subscribers hear of an answer once each", () => {
  it("tells two seats on the round and a unit-glob subscriber exactly once per answer", async () => {
    await placeRound(DECISION);
    await subscribe(subscriptionsDir, "seat-a", [DECISION], EARLIER);
    await subscribe(subscriptionsDir, "seat-b", [DECISION], EARLIER);
    await subscribe(subscriptionsDir, "seat-c", ["kiln-*"], EARLIER);
    await answer(DECISION, NOW);

    await listeners().afterRoundSubmit(DECISION, { status: "submitted" });
    await listeners().sweep();

    const text = answerNotice(DECISION, feedbackPath(DECISION), "subscriber", false);
    expect(sent.sort(bySeat)).toEqual([
      { seat: "seat-a", text },
      { seat: "seat-b", text },
      { seat: "seat-c", text },
    ]);
  });

  it("sends nothing more when the console restarts", async () => {
    await placeRound(DECISION);
    await subscribe(subscriptionsDir, "seat-a", [DECISION], EARLIER);
    await answer(DECISION, NOW);
    await listeners().afterRoundSubmit(DECISION, { status: "submitted" });

    await listeners().sweep();
    await listeners().sweep();

    expect(sent.map(({ seat }) => seat)).toEqual(["seat-a"]);
  });

  it("tells an asker that also subscribed once, as the asker", async () => {
    await placeRound(DECISION);
    await writeFile(path.join(roundsDir, DECISION, "asker.json"), JSON.stringify({ schema: "titan-console/asker@1", seat: "seat-a", initiative: null, filedAt: EARLIER.toISOString() }));
    await subscribe(subscriptionsDir, "seat-a", ["kiln-*"], EARLIER);
    await answer(DECISION, NOW);

    await listeners().afterRoundSubmit(DECISION, { status: "submitted" });

    expect(sent).toEqual([{ seat: "seat-a", text: answerNotice(DECISION, feedbackPath(DECISION), "asker", false) }]);
  });

  it("matches an owner/repo#N subscription to a Ship round that lands after it", async () => {
    await subscribe(subscriptionsDir, "seat-a", ["Example/Tiles#1"], EARLIER);
    await placeRound(SHIP);
    await answer(SHIP, NOW);

    await listeners().afterRoundSubmit(SHIP, { status: "submitted" });

    expect(sent.map(({ seat }) => seat)).toEqual(["seat-a"]);
  });

  it("does not tell a subscription of an answer written before it, so that answer stays unclaimed", async () => {
    await placeRound(DECISION);
    await answer(DECISION, NOW);
    await subscribe(subscriptionsDir, "seat-late", [DECISION], LATER);

    await listeners().sweep();

    expect(sent.map(({ seat }) => seat)).toEqual(["tp-operator"]);
  });

  it("stops telling a seat that unsubscribed", async () => {
    await placeRound(DECISION);
    await subscribe(subscriptionsDir, "seat-a", [DECISION], EARLIER);
    await unsubscribe(subscriptionsDir, "seat-a", [DECISION]);
    await subscribe(subscriptionsDir, "seat-b", [DECISION], EARLIER);
    await answer(DECISION, NOW);

    await listeners().afterRoundSubmit(DECISION, { status: "submitted" });

    expect(sent.map(({ seat }) => seat)).toEqual(["seat-b"]);
  });
});

describe("an answer no seat asked for", () => {
  it("goes to tp-operator", async () => {
    await placeRound(DECISION);
    await answer(DECISION, NOW);

    await listeners().afterRoundSubmit(DECISION, { status: "submitted" });

    expect(sent).toEqual([{ seat: "tp-operator", text: answerNotice(DECISION, feedbackPath(DECISION), "unclaimed", false) }]);
  });

  it("is not sent to tp-operator on the first start when it was answered before subscriptions existed", async () => {
    await placeRound(DECISION);
    await answer(DECISION, EARLIER);

    await listeners().sweep();

    expect(sent).toEqual([]);
  });

  it("is retried to tp-operator by the sweep when the live send failed", async () => {
    await listeners({ now: () => EARLIER }).sweep();
    await placeRound(DECISION);
    await answer(DECISION, NOW);
    await listeners({ notify: () => Promise.reject(new Error("no live session")) }).afterRoundSubmit(DECISION, { status: "submitted" });

    await listeners().sweep();

    expect(sent.map(({ seat }) => seat)).toEqual(["tp-operator"]);
  });
});

describe("the free-text flag", () => {
  it("is raised by a comment-only answer", async () => {
    await placeRound(DECISION);
    await subscribe(subscriptionsDir, "seat-a", [DECISION], EARLIER);
    await answer(DECISION, NOW, { answers: [{ questionId: "slot", comment: "Either works; prefer the earlier one." }] });

    await listeners().afterRoundSubmit(DECISION, { status: "submitted" });

    expect(sent).toEqual([{ seat: "seat-a", text: answerNotice(DECISION, feedbackPath(DECISION), "subscriber", true) }]);
  });

  it("is raised by general text alone", async () => {
    await placeRound(DECISION);
    await subscribe(subscriptionsDir, "seat-a", [DECISION], EARLIER);
    await answer(DECISION, NOW, { general: "See the note on timing." });

    await listeners().afterRoundSubmit(DECISION, { status: "submitted" });

    expect(sent[0]?.text).toContain("carries free text");
  });
});

const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const ownerContext = (): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites: true });

describe("rounds import --seat, then the owner answers", () => {
  it("sends the importing seat one notice for a Ship send-back, and none after a restart", async () => {
    const config = resolveConfig({ TITAN_CONSOLE_STATE: path.join(root, "state"), TITAN_CONSOLE_HOST: "" }, root);
    const source = path.join(root, "source");
    await cp(IMPORT_FIXTURE, source, { recursive: true });
    await rm(path.join(source, "feedback.json"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    await importRoundCli(config, { dir: source, seat: "seat-importer", json: false });
    const manifestSha256 = createHash("sha256").update(await readFile(path.join(IMPORT_FIXTURE, "round.json"))).digest("hex");
    const submit = roundsSubmitCommands({ dir: config.roundsDir }, undefined, listeners())["rounds.submit"];

    await invokeCommand(submit, { id: "sample-batch-r2", manifestSha256, answers: [{ questionId: "ship-cards", pick: "Don't ship", comment: "The card edge clips." }] }, ownerContext());
    await listeners().sweep();

    expect(sent).toEqual([{ seat: "seat-importer", text: answerNotice("sample-batch-r2", feedbackPath("sample-batch-r2"), "asker", true) }]);
  });
});

describe("subscription targets and store", () => {
  it.each([
    ["kiln-schedule-r2", "kiln-schedule-r2"],
    ["kiln-*", "kiln-*"],
    ["Example/Tiles#12", "example/tiles#12"],
    ["example/tiles#0", null],
    ["../etc", null],
    ["a b", null],
  ])("reads target %j as %j", (raw, expected) => {
    expect(normalTarget(raw)).toBe(expected);
  });

  it("keeps the first subscription when a seat subscribes twice", async () => {
    const first = await subscribe(subscriptionsDir, "seat-a", [DECISION], EARLIER);
    const second = await subscribe(subscriptionsDir, "seat-a", [DECISION], NOW);

    expect([first, second]).toEqual([[{ target: DECISION, created: true }], [{ target: DECISION, created: false }]]);
    expect(await listSubscriptions(subscriptionsDir)).toEqual([{ schema: "titan-console/round-subscription@1", seat: "seat-a", target: DECISION, at: EARLIER.toISOString() }]);
  });

  it("refuses a seat that is not an agent-chat name and a target that is not one", async () => {
    await expect(subscribe(subscriptionsDir, "Seat A", [DECISION])).rejects.toMatchObject({ code: EXIT.USAGE });
    await expect(subscribe(subscriptionsDir, "seat-a", ["no/such"])).rejects.toMatchObject({ code: EXIT.USAGE });
    expect(await listSubscriptions(subscriptionsDir)).toEqual([]);
  });
});

describe("rounds subscribe, unsubscribe and list-subscriptions", () => {
  it.each([
    [["rounds", "subscribe", "r-1", "kiln-*", "--seat", "seat-a"], { verb: "subscribe", targets: ["r-1", "kiln-*"], seat: "seat-a", json: false }],
    [["rounds", "subscribe", "--json", "r-1"], { verb: "subscribe", targets: ["r-1"], seat: "env-seat", json: true }],
    [["rounds", "unsubscribe", "r-1", "--seat", "seat-a"], { verb: "unsubscribe", targets: ["r-1"], seat: "seat-a", json: false }],
    [["rounds", "list-subscriptions"], { verb: "list-subscriptions", targets: [], seat: null, json: false }],
    [["rounds", "list-subscriptions", "--seat", "seat-a", "--json"], { verb: "list-subscriptions", targets: [], seat: "seat-a", json: true }],
    [["rounds", "subscribe"], null],
    [["rounds", "subscribe", "r-1", "--initiative", "x"], null],
    [["rounds", "subscribe", "r-1", "--other"], null],
    [["rounds", "list-subscriptions", "r-1"], null],
  ])("reads %j as %j", (argv, expected) => {
    expect(subscriptionArgs(argv, { AGENT_CHAT_NAME: "env-seat" })).toEqual(expected);
  });

  it("subscribes, lists and unsubscribes through the verbs", async () => {
    const config = resolveConfig({ TITAN_CONSOLE_STATE: path.join(root, "state"), TITAN_CONSOLE_HOST: "" }, root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await subscriptionCli(config, { verb: "subscribe", targets: ["kiln-*"], seat: "seat-a", json: false });
    await subscriptionCli(config, { verb: "list-subscriptions", targets: [], seat: null, json: true });
    await subscriptionCli(config, { verb: "unsubscribe", targets: ["kiln-*"], seat: "seat-a", json: false });
    await subscriptionCli(config, { verb: "list-subscriptions", targets: [], seat: null, json: false });

    expect(log.mock.calls[0]?.[0]).toBe("subscribed: seat-a kiln-*");
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual([{ schema: "titan-console/round-subscription@1", seat: "seat-a", target: "kiln-*", at: expect.any(String) }]);
    expect(log.mock.calls.slice(2).map(([line]) => line)).toEqual(["unsubscribed: seat-a kiln-*", "no subscriptions"]);
  });

  it("refuses subscribe with no seat and no AGENT_CHAT_NAME", async () => {
    const config = resolveConfig({ TITAN_CONSOLE_STATE: path.join(root, "state"), TITAN_CONSOLE_HOST: "" }, root);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await subscriptionCli(config, { verb: "subscribe", targets: [DECISION], seat: null, json: false });

    expect(process.exitCode).toBe(EXIT.USAGE);
    expect(error).toHaveBeenCalledWith("subscribe refused: name the seat with --seat <name> (or set AGENT_CHAT_NAME)");
  });
});

import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId, type OwnerItem, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { writeAnswer, writeDeposit } from "@titan-design/owner-queue/spool";
import { FEEDBACK_SCHEMA_ID, MANIFEST_SCHEMA_ID, SHIP_OPTIONS, type ManifestInput } from "@titan-design/review-schema";
import { readFlow, type ApprovalsFlow, type ApprovalsSources } from "./approvals.js";
import { consoleCommands } from "./commands.js";
import { resolveConfig } from "./config.js";
import { factoryNeeds } from "./factory.js";
import { withdrawRound } from "./round-withdraw.js";
import { closedPort, startFakeDaemon, type FakeDaemon } from "./test-support.js";
import { createSources } from "./upstreams.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const PR = "o/r#1";
const ASKER = "pc-test-agent";
const OWNER = { class: "owner", id: "owner", channel: "console" };
const GATE = "gate:cc347d3e-9a84-431a-afa5-ce157e10b664/approve-merge";
const SENTINEL = "RATIONALE-SENTINEL-7";

let root: string;
let factory: FakeDaemon | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-approvals-"));
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(root, { recursive: true, force: true });
});

function item(id: string, overrides: Partial<OwnerItem> = {}): OwnerItem {
  return {
    id,
    sources: [{ system: "agent-chat", ref: id }],
    kind: "decide",
    door: "two-way",
    summary: `Settle ${id}?`,
    context: "",
    keys: [],
    personal: false,
    lens: "blocking-agent",
    unblocks: [],
    openedAt: "2026-10-01T00:00:00.000Z",
    status: "open",
    ...overrides,
  };
}

const hitlGate = (): OwnerItem =>
  item(GATE, { sources: [{ system: "hitl", ref: GATE.slice("gate:".length) }], kind: "approve", door: "one-way", lens: "blocking-merge", keys: [GATE, "run:cc347d3e"], openedAt: "2026-10-09T15:20:51.359Z" });

async function serveFactory(items: readonly OwnerItem[], gaps: string[] = []): Promise<ApprovalsSources["factory"]> {
  factory = await startFakeDaemon({ ok: true }, () => ({ items, gaps }));
  return factoryNeeds(factory.port);
}

function sources(factorySource: ApprovalsSources["factory"]): ApprovalsSources {
  return { factory: factorySource, inbox: { dir: path.join(root, "deposits") }, rounds: { dir: path.join(root, "rounds") } };
}

function deposit(depositId: string, overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return { depositId, asker: ASKER, kind: "decide", door: "two-way", summary: `Deposit ${depositId}?`, context: "", ...overrides };
}

async function answerDeposit(depositId: string): Promise<void> {
  await writeAnswer(path.join(root, "deposits"), depositItemId(ASKER, depositId), { optionId: "yes", by: OWNER, at: "2026-10-02T00:00:00.000Z" });
}

type Question = ManifestInput["questions"][number];
type Recommendation = Extract<Question, { kind: "pick-one" }>["recommendation"];

const shipQuestion = (sha: string, recommendation?: Recommendation): Question => ({
  id: "ship",
  kind: "pick-one",
  prompt: "Ship at this head?",
  options: [...SHIP_OPTIONS],
  required: true,
  page: PR,
  signsOff: "change",
  merge: { repo: "o/r", pr: 1, headSha: sha, ship: ["Ship"] },
  ...(recommendation === undefined ? {} : { recommendation }),
});

function manifest(unit: string, questions: Question[], overrides: Partial<ManifestInput> = {}): ManifestInput {
  const parts = [{ id: "change", label: "The change", proposed: "ship()", lang: "ts" }];
  const sections = [{ id: "all", title: "All", deciding: "Whether it ships", changed: "The ship path", context: "Nothing else", parts, questionIds: questions.map((question) => question.id) }];
  return { schema: MANIFEST_SCHEMA_ID, unit, round: 1, storybookUrl: "http://127.0.0.1:6006", widths: [1280], variants: [], sections, questions, ...overrides };
}

/** `openedAt` of a round item is its round.json mtime, so withdrawal tests pin it. */
async function writeRound(id: string, round: ManifestInput, answers?: unknown[], at = new Date("2026-09-01T00:00:00Z")): Promise<void> {
  const dir = path.join(root, "rounds", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "round.json"), JSON.stringify(round));
  await utimes(path.join(dir, "round.json"), at, at);
  if (answers === undefined) return;
  const feedback = { schema: FEEDBACK_SCHEMA_ID, unit: round.unit, round: round.round, manifestSha256: "0".repeat(64), submittedAt: "2026-09-02T00:00:00.000Z", answers, variants: [], general: "" };
  await writeFile(path.join(dir, "feedback.json"), JSON.stringify(feedback));
}

const ids = (items: readonly OwnerItem[]) => items.map((each) => each.id);
const prGroup = (result: ApprovalsFlow) => result.flow.groups.find((group) => group.id === `pr:${PR}`);

describe("approvals.flow", () => {
  it("orders topic groups before PR groups, holds the dependent, and ignores input order", async () => {
    const items = [
      item("t1", { keys: ["topic:alerts"], openedAt: "2026-10-01T00:00:00.000Z" }),
      item("t2", { kind: "approve", keys: ["topic:alerts"], openedAt: "2026-10-01T01:00:00.000Z" }),
      item("t3", { keys: ["topic:billing"], openedAt: "2026-10-01T02:00:00.000Z" }),
      item("p1", { kind: "approve", keys: [`pr:o/r#1@${SHA_A}`], openedAt: "2026-10-01T03:00:00.000Z" }),
      item("p2", { kind: "approve", keys: [`pr:o/r#2@${SHA_A}`], openedAt: "2026-10-01T04:00:00.000Z" }),
    ];

    const forward = await readFlow(sources(await serveFactory(items)));
    await factory?.close();
    const reversed = await readFlow(sources(await serveFactory([...items].reverse())));

    expect(ids(forward.flow.order)).toEqual(["t1", "t2", "t3", "p1", "p2"]);
    expect(forward.flow.groups.map((group) => group.kind)).toEqual(["topic", "topic", "pr", "pr"]);
    expect(forward.flow.held).toEqual([{ itemId: "t2", waitsOn: ["t1"] }]);
    expect(reversed.flow).toEqual(forward.flow);
  });

  it("withdraws a round question pinned to an older head than the factory's item", async () => {
    await writeRound("ship-r1", manifest("ship", [shipQuestion(SHA_A)]));
    const newer = item("gate-newer", { kind: "approve", keys: [`pr:${PR}@${SHA_B}`], openedAt: "2026-10-01T00:00:00.000Z" });

    const result = await readFlow(sources(await serveFactory([newer])));

    expect(result.flow.withdrawn).toMatchObject([{ item: { id: "round:ship-r1/ship" }, reason: `new-head:${SHA_B}` }]);
    expect(ids(result.flow.order)).toEqual(["gate-newer"]);
  });

  it("lists a withdrawn round's questions as withdrawn with its reason, never as open", async () => {
    await writeRound("ship-r1", manifest("ship", [shipQuestion(SHA_A)]));
    await writeRound("kept-r1", manifest("kept", [{ id: "fill", kind: "pick-one", prompt: "Fill?", options: ["a", "b"], signsOff: "change" }]));
    await withdrawRound(path.join(root, "rounds"), "ship-r1", `new-head:${SHA_B}`);

    const result = await readFlow(sources(undefined));

    expect(ids(result.flow.order)).toEqual(["round:kept-r1/fill"]);
    expect(result.flow.withdrawn).toEqual([
      { item: expect.objectContaining({ id: "round:ship-r1/ship", status: "withdrawn" }), was: "open", pr: PR, reason: `new-head:${SHA_B}` },
    ]);
    expect(prGroup(result)).toBeUndefined();
  });

  it("drops an open factory ask that a spool answer on the same ask key already settled", async () => {
    await writeDeposit(path.join(root, "deposits"), deposit("settled", { keys: ["ask:retry-policy"] }));
    await answerDeposit("settled");

    const result = await readFlow(sources(await serveFactory([item("ac-ask", { keys: ["ask:retry-policy"] })])));

    expect(result.flow.dropped).toMatchObject([{ item: { id: "ac-ask", status: "gone-elsewhere" }, cite: { answerId: depositItemId(ASKER, "settled") } }]);
    expect(result.flow.order).toEqual([]);
  });

  it("blocks Ship on a change request but not on an unanswered question", async () => {
    const pending = item("pending-merge", { kind: "approve", keys: [`pr:${PR}@${SHA_A}`] });
    await writeRound("changes-r1", manifest("changes", [shipQuestion(SHA_A)]), [{ questionId: "ship", revisionRequested: true }]);
    await writeRound("open-r1", manifest("open", [shipQuestion(SHA_A)]));

    const blocked = await readFlow(sources(await serveFactory([pending])));
    await factory?.close();
    await rm(path.join(root, "rounds", "changes-r1"), { recursive: true });
    const unanswered = await readFlow(sources(await serveFactory([pending])));

    expect(prGroup(blocked)?.shipBlockedBy).toMatchObject([{ itemId: "round:changes-r1/ship", reason: "change-requested" }]);
    expect(ids(unanswered.flow.order)).toContain("round:open-r1/ship");
    expect(prGroup(unanswered)?.shipBlockedBy).toEqual([]);
  });

  it("blocks Ship when the owner picked other than the implemented choice", async () => {
    const recommendation = { answer: "Ship", by: "implementer", rationale: "CI is green", confidence: 0.9 };
    await writeRound("other-r1", manifest("other", [shipQuestion(SHA_A, recommendation)]), [{ questionId: "ship", pick: "Don't ship" }]);

    const result = await readFlow(sources(await serveFactory([item("pending-merge", { kind: "approve", keys: [`pr:${PR}@${SHA_A}`] })])));

    expect(result.gaps).toEqual([]);
    expect(prGroup(result)?.shipBlockedBy).toMatchObject([{ itemId: "round:other-r1/ship", reason: "other-choice" }]);
  });

  it("reports a factory outage as one gap and still lists the spool and the rounds", async () => {
    await writeDeposit(path.join(root, "deposits"), deposit("still-here"));
    await writeRound("open-r1", manifest("open", [shipQuestion(SHA_A)]));

    const result = await readFlow(sources(factoryNeeds(await closedPort())));

    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatch(/^factory: /);
    expect(ids(result.flow.order).sort()).toEqual([depositItemId(ASKER, "still-here"), "round:open-r1/ship"].sort());
  });

  it("forwards the factory's own dead-source lines as factory gaps", async () => {
    const result = await readFlow(sources(await serveFactory([], ["morning: unreachable"])));

    expect(result.gaps).toEqual(["factory: morning: unreachable"]);
  });

  it("never shows an unsent after-answer recommendation, in order, withdrawn or dropped", async () => {
    const hidden = (answer: string): Recommendation => ({ answer, by: "implementer", rationale: SENTINEL, confidence: 0.6 });
    const pick = (id: string): Question => ({ id, kind: "pick-one", prompt: `${id}?`, options: [`${id}-a`, `${id}-b`], signsOff: "change", recommendation: hidden(`${id}-b`) });
    await writeRound("hidden-r1", manifest("hidden", [pick("fill"), pick("notes"), shipQuestion(SHA_A, hidden("Don't ship"))], { recommendations: "after-answer" }));
    await writeDeposit(path.join(root, "deposits"), deposit("notes-answer", { keys: ["ask:hidden/notes"] }));
    await answerDeposit("notes-answer");
    const newer = item("gate-newer", { kind: "approve", keys: [`pr:${PR}@${SHA_B}`] });

    const result = await readFlow(sources(await serveFactory([newer])));

    expect(result.gaps).toEqual([]);
    const everyItem = [...result.flow.order, ...result.flow.withdrawn.map((each) => each.item), ...result.flow.dropped.map((each) => each.item)];
    expect(ids(everyItem).sort()).toEqual(["gate-newer", "round:hidden-r1/fill", "round:hidden-r1/notes", "round:hidden-r1/ship"]);
    for (const each of everyItem) expect(each.recommended).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("counts fyi notices instead of ordering them", async () => {
    const notices = [1, 2, 3].map((n) => item(`notice-${n}`, { kind: "know", lens: "fyi" }));

    const result = await readFlow(sources(await serveFactory([...notices, item("real-ask")])));

    expect(result.fyiCount).toBe(3);
    expect(ids(result.flow.order)).toEqual(["real-ask"]);
  });

  it("lists a deposit once, from the console spool, when the factory also carries it", async () => {
    await writeDeposit(path.join(root, "deposits"), deposit("twice"));
    const id = depositItemId(ASKER, "twice");
    const factoryCopy = item(id, { sources: [{ system: "deposit", ref: `${ASKER}/twice` }], summary: "The factory's copy" });

    const result = await readFlow(sources(await serveFactory([factoryCopy])));

    expect(result.flow.order).toMatchObject([{ id, summary: "Deposit twice?" }]);
  });

  it.each(["approve", "decide"] as const)("never lets a %s deposit carrying a gate key take the gate's place", async (kind) => {
    await writeDeposit(path.join(root, "deposits"), deposit("impostor", { kind, keys: [GATE] }));
    const impostor = depositItemId(ASKER, "impostor");

    const result = await readFlow(sources(await serveFactory([hitlGate()])));

    const holders = result.flow.order.filter((each) => each.keys.includes(GATE));
    expect(holders).toMatchObject([{ id: GATE, sources: [{ system: "hitl" }] }]);
    expect(ids(result.flow.order).indexOf(impostor)).toBeGreaterThan(ids(result.flow.order).indexOf(GATE));
    expect(result.flow.held).toEqual([]);
  });

  it("consolidates 500 live-sized asks within the default timeout", async () => {
    const many = Array.from({ length: 500 }, (_, n) => item(`ask-${n}`, { keys: [`topic:t${n % 40}`] }));

    const result = await readFlow(sources(await serveFactory(many)));

    expect(result.flow.order).toHaveLength(500);
  });

  it("returns readAt as an ISO time and the factory leg's gap when no factory is configured", async () => {
    const result = await readFlow(sources(undefined));

    expect(result.gaps).toEqual(["factory: upstream not configured"]);
    expect(Date.parse(result.readAt)).not.toBeNaN();
  });

  it("is registered as a read command and wired to the factory by createSources", () => {
    const wired = createSources(resolveConfig({}, root));

    const command = consoleCommands({ ...wired, factory: undefined })["approvals.flow"];

    expect(command.commandClass).toBe("read");
    expect(wired.factory).toBeDefined();
  });
});

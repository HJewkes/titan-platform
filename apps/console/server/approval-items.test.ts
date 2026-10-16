import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { answerFileName, writeAnswer, writeDeposit } from "@titan-design/owner-queue/spool";
import { roundQueueItems, spoolQueueItems } from "./approval-items.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { withdrawRound } from "./round-withdraw.js";
import { readQueueRounds, type QueueRound } from "./rounds.js";

const ASKER = "pc-test-agent";
const OWNER = { class: "owner", id: "owner", channel: "console" };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-approval-items-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixtureRounds(prepare: (dir: string) => Promise<unknown> = async () => undefined): Promise<QueueRound[]> {
  const dir = path.join(root, "rounds");
  await cp(FIXTURE_ROUNDS.dir, dir, { recursive: true });
  await prepare(dir);
  return (await readQueueRounds({ dir })).rounds;
}

const roundOf = (rounds: readonly QueueRound[], id: string): QueueRound => {
  const round = rounds.find((each) => each.id === id);
  if (round === undefined) throw new Error(`no fixture round ${id}`);
  return round;
};

function deposit(depositId: string): OwnerItemDeposit {
  return {
    depositId,
    asker: ASKER,
    kind: "decide",
    door: "two-way",
    summary: `Ship ${depositId} behind a flag?`,
    context: "The flag defaults off.",
    options: [
      { id: "yes", label: "Ship it" },
      { id: "no", label: "Hold" },
    ],
  };
}

describe("roundQueueItems", () => {
  it("asks an unsent after-answer round's questions with every recommendation hidden", async () => {
    const { open } = roundQueueItems([roundOf(await fixtureRounds(), "kiln-schedule-r2")]);

    expect(open.map((item) => item.id)).toContain("round:kiln-schedule-r2/ramp-default");
    const recommended = open.flatMap((item) => (item.recommended === undefined ? [] : [item.recommended]));
    expect(recommended.length).toBeGreaterThan(0);
    for (const each of recommended) expect(each.hidden).toBe(true);
  });

  it("gives a sent round's questions as answered with the owner's pick, never also as open", async () => {
    const items = roundQueueItems([roundOf(await fixtureRounds(), "kiln-schedule-r1")]);

    expect(items.open).toEqual([]);
    expect(items.answered).toHaveLength(1);
    expect(items.answered[0]).toMatchObject({ id: "round:kiln-schedule-r1/unit-start", status: "answered", answer: { optionId: "Celsius" } });
    expect(items.gaps).toEqual([]);
  });

  it("lists a withdrawn round's questions as withdrawn, with their hidden picks kept hidden", async () => {
    const rounds = await fixtureRounds((dir) => withdrawRound(dir, "kiln-schedule-r2", "closed"));

    const items = roundQueueItems([roundOf(rounds, "kiln-schedule-r2")]);

    expect(items.open).toEqual([]);
    expect(items.withdrawn.map((each) => [each.item.status, each.was, each.pr, each.reason])).toContainEqual(["withdrawn", "open", "", "closed"]);
    for (const each of items.withdrawn) expect(each.item.recommended?.hidden ?? true).toBe(true);
  });

  it("keeps an answered round answered even when a withdrawn.json sits beside it", async () => {
    const rounds = await fixtureRounds((dir) => writeFile(path.join(dir, "kiln-schedule-r1", "withdrawn.json"), "{}"));

    const items = roundQueueItems([roundOf(rounds, "kiln-schedule-r1")]);

    expect(items.withdrawn).toEqual([]);
    expect(items.answered.map((item) => item.id)).toEqual(["round:kiln-schedule-r1/unit-start"]);
  });

  it("withdraws a round whose withdrawn.json does not parse, and ignores one that is a directory", async () => {
    const rounds = await fixtureRounds(async (dir) => {
      await writeFile(path.join(dir, "kiln-schedule-r2", "withdrawn.json"), "not json");
      await mkdir(path.join(dir, "orbit-retry-r1", "withdrawn.json"));
    });

    const garbled = roundQueueItems([roundOf(rounds, "kiln-schedule-r2")]);
    const directory = roundQueueItems([roundOf(rounds, "orbit-retry-r1")]);

    expect(garbled.open).toEqual([]);
    expect(new Set(garbled.withdrawn.map((each) => each.reason))).toEqual(new Set(["unreadable"]));
    expect(directory.withdrawn).toEqual([]);
    expect(directory.open.length).toBeGreaterThan(0);
  });

  it("keeps a round open and reports a gap when its feedback is for another unit", async () => {
    const sent = roundOf(await fixtureRounds(), "kiln-schedule-r1");
    if (sent.feedback === null) throw new Error("the kiln-schedule-r1 fixture has no feedback");
    const misfiled = { ...sent, feedback: { ...sent.feedback, unit: "orbit-retry" } };

    const items = roundQueueItems([misfiled]);

    expect(items.answered).toEqual([]);
    expect(items.open.map((item) => item.id)).toEqual(["round:kiln-schedule-r1/unit-start"]);
    expect(items.gaps).toEqual(["kiln-schedule-r1: feedback.json does not fit its round"]);
  });
});

describe("spoolQueueItems", () => {
  let spool: string;

  beforeEach(() => {
    spool = path.join(root, "deposits");
  });

  it("gives a deposit with an answer file as answered and the other as open", async () => {
    await writeDeposit(spool, deposit("ask-1"));
    await writeDeposit(spool, deposit("ask-2"));
    const answered = depositItemId(ASKER, "ask-2");
    await writeAnswer(spool, answered, { optionId: "yes", by: OWNER, at: "2031-03-02T10:00:00.000Z" });

    const items = await spoolQueueItems(spool);

    expect(items.open.map((item) => item.id)).toEqual([depositItemId(ASKER, "ask-1")]);
    expect(items.answered).toHaveLength(1);
    expect(items.answered[0]).toMatchObject({ id: answered, status: "answered", answer: { optionId: "yes", by: OWNER } });
    expect(items.gaps).toEqual([]);
  });

  it("keeps a deposit open and reports a gap when its answer file is malformed", async () => {
    await writeDeposit(spool, deposit("ask-1"));
    const id = depositItemId(ASKER, "ask-1");
    await writeFile(path.join(spool, answerFileName(id)), "{}");

    const items = await spoolQueueItems(spool);

    expect(items.open.map((item) => item.id)).toEqual([id]);
    expect(items.answered).toEqual([]);
    expect(items.gaps).toEqual([`${id}: its answer file is malformed`]);
  });

  it("reports a rejected spool file as a gap that does not quote its contents", async () => {
    await writeDeposit(spool, deposit("ask-1"));
    await writeFile(path.join(spool, "junk.json"), "SECRET-PLANTED-TEXT {");

    const items = await spoolQueueItems(spool);

    expect(items.open).toHaveLength(1);
    expect(items.gaps).toEqual(["junk.json: not valid JSON"]);
    expect(JSON.stringify(items)).not.toContain("SECRET-PLANTED-TEXT");
  });

  it("answers an empty leg with no gaps when the spool does not exist yet", async () => {
    expect(await spoolQueueItems(spool)).toEqual({ open: [], answered: [], gaps: [] });
  });
});

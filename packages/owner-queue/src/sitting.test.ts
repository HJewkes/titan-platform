import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId, type OwnerItemDeposit } from "./deposit.js";
import { recordStep, SITTING_LOG, StepRefusedError, withStepOutcomes, type StepRequest } from "./sitting.js";
import { readAnswer, readSpool, writeDeposit } from "./spool.js";
import { withdrawDeposit } from "./withdraw.js";

const NOW = new Date("2031-03-05T12:00:00.000Z");
const ASKER = "seat-a";
const OPS = "seat-ops";
const ID = depositItemId(ASKER, "sit-1");

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "owner-queue-sitting-"));
  dir = join(root, "deposits");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sitting(overrides: Partial<OwnerItemDeposit> = {}): OwnerItemDeposit {
  return {
    depositId: "sit-1",
    asker: ASKER,
    kind: "do",
    door: "two-way",
    summary: "Terminal sitting",
    context: "Run these in order.",
    steps: [
      { title: "First", command: "example-cli one" },
      { title: "Second", command: "example-cli two" },
      { title: "Third", command: "example-cli three" },
    ],
    ...overrides,
  };
}

const request = (outcome: StepRequest["outcome"], overrides: Partial<StepRequest> = {}): StepRequest => ({ outcome, as: ASKER, actor: OPS, now: NOW, ...overrides });

async function outcomes(): Promise<(string | undefined)[]> {
  const [item] = (await readSpool(dir)).items;
  return ((await withStepOutcomes(dir, item!)).steps ?? []).map((step) => step.outcome);
}

async function refusal(run: Promise<unknown>): Promise<StepRefusedError> {
  const error = await run.then(() => undefined, (caught: unknown) => caught);
  if (!(error instanceof StepRefusedError)) throw new Error("expected a StepRefusedError");
  return error;
}

describe("recordStep", () => {
  it("records one step's outcome, leaves the rest open and the sitting unanswered", async () => {
    await writeDeposit(dir, sitting());

    expect(await recordStep(dir, ID, 2, request("done"))).toEqual({ id: ID, step: 2, outcome: "done", result: "recorded", closed: false });

    expect(await outcomes()).toEqual([undefined, "done", undefined]);
    expect(await readAnswer(dir, ID)).toBeUndefined();
  });

  it("closes the sitting with a tally answer when the last open step is recorded", async () => {
    await writeDeposit(dir, sitting());
    await recordStep(dir, ID, 1, request("done"));
    await recordStep(dir, ID, 3, request("skipped"));

    const last = await recordStep(dir, ID, 2, request("done"));

    expect(last.closed).toBe(true);
    expect(await readAnswer(dir, ID)).toEqual({ text: "sitting complete: 2 done, 1 skipped", by: { class: "asker", id: ASKER, channel: "inbox-step" }, at: NOW.toISOString() });
  });

  it("keeps the first outcome when a step is recorded twice", async () => {
    await writeDeposit(dir, sitting());
    await recordStep(dir, ID, 1, request("skipped"));

    expect(await recordStep(dir, ID, 1, request("done"))).toMatchObject({ outcome: "skipped", result: "already-recorded" });
    expect(await outcomes()).toEqual(["skipped", undefined, undefined]);
  });

  it("logs each recorded step with asker, actor and time", async () => {
    await writeDeposit(dir, sitting());
    await recordStep(dir, ID.slice(0, 16), 1, request("done"));

    const lines = (await readFile(join(dir, SITTING_LOG), "utf8")).trim().split("\n").map((line): unknown => JSON.parse(line));
    expect(lines).toEqual([{ op: "step", id: ID, step: 1, outcome: "done", by: ASKER, actor: OPS, at: NOW.toISOString() }]);
  });

  it.each([0, 4, 1.5])("refuses step %s, outside the sitting's steps", async (step) => {
    await writeDeposit(dir, sitting());

    expect((await refusal(recordStep(dir, ID, step, request("done")))).kind).toBe("refused");
  });

  it("refuses another seat's sitting and a deposit with no steps", async () => {
    await writeDeposit(dir, sitting());
    await writeDeposit(dir, sitting({ depositId: "plain", steps: undefined }));

    expect((await refusal(recordStep(dir, ID, 1, request("done", { as: "seat-b" })))).message).toMatch(/filed by seat-a, not seat-b/);
    expect((await refusal(recordStep(dir, depositItemId(ASKER, "plain"), 1, request("done")))).message).toMatch(/not a sitting/);
  });

  it("refuses a withdrawn sitting and answers unknown for an id nobody filed", async () => {
    await writeDeposit(dir, sitting());
    await withdrawDeposit(dir, ID, { reason: "obsolete", as: ASKER, actor: OPS, now: NOW });

    expect((await refusal(recordStep(dir, ID, 1, request("done")))).message).toMatch(/withdrawn/);
    expect((await refusal(recordStep(dir, "deposit:0123456789abcdef", 1, request("done")))).kind).toBe("unknown");
  });

  it("refuses a missing actor", async () => {
    await writeDeposit(dir, sitting());

    expect((await refusal(recordStep(dir, ID, 1, request("done", { actor: " " })))).message).toMatch(/actor is required/);
  });
});

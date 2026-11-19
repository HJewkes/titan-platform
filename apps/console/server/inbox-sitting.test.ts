import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { askKey, consolidate, type OwnerItem, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { recordStep } from "@titan-design/owner-queue/sitting";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { INBOX_DEPOSIT, MAX_OPEN_DEPOSITS_PER_ASKER, inboxCommands } from "./inbox.js";
import { spoolQueueItems } from "./approval-items.js";
import { actionFor } from "./inbox-view.js";
import type { ConsoleContext } from "./owner-guard.js";

const ASKER = "seat-a";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const MERGE = { kind: "merge-at-head", repo: "example/repo", pr: 7, headSha: HEAD } as const;

let dir: string;

beforeEach(async () => {
  dir = path.join(await mkdtemp(path.join(tmpdir(), "console-sitting-")), "deposits");
});

afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

const twentySteps = Array.from({ length: 20 }, (_, index) => ({ title: `Step ${index + 1}`, command: `example-cli step-${index + 1}` }));

const plain = (depositId: string): OwnerItemDeposit => ({ depositId, asker: ASKER, kind: "do", door: "two-way", summary: `Do ${depositId}`, context: "" });
const sitting = (depositId: string, steps: OwnerItemDeposit["steps"] = twentySteps): OwnerItemDeposit => ({ ...plain(depositId), summary: "Terminal sitting", steps });

const LOOPBACK: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: null, ownerWrites: false };
const filed = z.object({ id: z.string(), created: z.boolean() });

/** The deposit RPC as the daemon serves it over loopback http. */
async function file(deposit: OwnerItemDeposit): Promise<z.infer<typeof filed>> {
  const command = inboxCommands({ dir })[INBOX_DEPOSIT];
  return filed.parse(await command.run(deposit, LOOPBACK));
}

describe("the per-asker cap and a sitting", () => {
  it("counts a twenty-step sitting as one open deposit", async () => {
    for (let index = 0; index < MAX_OPEN_DEPOSITS_PER_ASKER - 1; index += 1) await writeDeposit(dir, plain(`seed-${index}`));

    await expect(file(sitting("sit-1"))).resolves.toMatchObject({ created: true });
    await expect(file(plain("one-too-many"))).rejects.toThrow(`this asker already has ${MAX_OPEN_DEPOSITS_PER_ASKER} open deposits`);
  });

  it("frees its slot once every step is done or skipped", async () => {
    for (let index = 0; index < MAX_OPEN_DEPOSITS_PER_ASKER - 1; index += 1) await writeDeposit(dir, plain(`seed-${index}`));
    const { id } = await file(sitting("sit-1", [{ title: "Only", command: "example-cli only" }]));

    await recordStep(dir, id, 1, { outcome: "skipped", as: ASKER, actor: ASKER });

    await expect(file(plain("after-close"))).resolves.toMatchObject({ created: true });
  });
});

describe("a closed sitting and other owner asks", () => {
  it("leaves another seat's open ask with the same ask key in the flow when its asker closes the sitting", async () => {
    const shared = askKey("unit-a/q1");
    await writeDeposit(dir, { ...plain("other-ask"), asker: "seat-b", keys: [shared] });
    const { id } = await file({ ...sitting("sit-1", [{ title: "Only", command: "example-cli only" }]), keys: [shared] });
    await recordStep(dir, id, 1, { outcome: "done", as: ASKER, actor: ASKER });

    const { open, answered } = await spoolQueueItems(dir);
    const flow = consolidate(open, { answered });

    expect(answered.map((item) => item.id)).toEqual([id]);
    expect(flow.order.map((item) => item.asker)).toEqual(["seat-b"]);
    expect(flow.dropped).toEqual([]);
  });
});

function sittingItem(steps: NonNullable<OwnerItem["steps"]>): OwnerItem {
  return {
    id: "deposit:sit",
    sources: [{ system: "deposit", ref: `${ASKER}/sit` }],
    kind: "do",
    door: "two-way",
    summary: "Terminal sitting",
    context: "",
    keys: [],
    personal: false,
    lens: "blocking-agent",
    unblocks: [],
    openedAt: "2031-01-01T00:00:00.000Z",
    status: "open",
    asker: ASKER,
    steps,
  };
}

describe("actionFor on a sitting", () => {
  it("offers the current step's op as the existing owner-op tap", () => {
    const item = sittingItem([{ title: "Install", command: "example-cli install", outcome: "done" }, { title: "Merge", command: "example-cli merge 7", op: MERGE }]);

    expect(actionFor(item, undefined).action).toEqual({ kind: "owner-op", op: MERGE });
  });

  it("offers an answer once the step carrying the op is recorded, and never a later step's op", () => {
    const pastOp = sittingItem([{ title: "Merge", command: "example-cli merge 7", op: MERGE, outcome: "done" }, { title: "Restart", command: "example-daemon restart" }]);
    const opLater = sittingItem([{ title: "Restart", command: "example-daemon restart" }, { title: "Merge", command: "example-cli merge 7", op: MERGE }]);

    expect(actionFor(pastOp, undefined).action).toEqual({ kind: "answer-deposit" });
    expect(actionFor(opLater, undefined).action).toEqual({ kind: "answer-deposit" });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depositItemId, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { readWithdrawal } from "@titan-design/owner-queue/withdraw";
import { incidentDeposit } from "./deploy-incident.js";
import { configuredDeployResolve } from "./deploy-watch-ports.js";

let root: string;
let spool: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-deploy-resolve-"));
  spool = join(root, "deposits");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A stall alarm as builds before the alarm key filed it: only the `deploy-alarm` key. */
const legacyAlarm: OwnerItemDeposit = {
  depositId: `deploy-alarm-${"1".repeat(40)}`,
  asker: "titan-factory",
  kind: "do",
  door: "two-way",
  summary: "titan-factory deploys stalled for 30 min",
  context: "Merged work is not live until a deploy lands.",
  keys: ["deploy-alarm"],
};

describe("the deploy resolve wired into service deploy", () => {
  it("withdraws the factory's open stall alarms and rollback incidents as resolved, and nothing another asker filed", async () => {
    const incident = incidentDeposit({ kind: "rolled-back", target: "2".repeat(40), from: "1".repeat(40), why: "no /health", at: "2031-03-05T12:00:00.000Z" });
    await writeDeposit(spool, legacyAlarm);
    await writeDeposit(spool, incident);
    await writeDeposit(spool, { ...legacyAlarm, asker: "seat-x" });
    const resolve = configuredDeployResolve({ TITAN_CONSOLE_INBOX_DIR: spool });

    expect(await resolve()).toBe(2);

    expect(await readWithdrawal(spool, depositItemId("titan-factory", legacyAlarm.depositId))).toMatchObject({ reason: "resolved", by: "titan-factory", actor: "titan-factory" });
    expect(await readWithdrawal(spool, depositItemId("titan-factory", incident.depositId))).toMatchObject({ reason: "resolved", by: "titan-factory", actor: "titan-factory" });
    expect(await readWithdrawal(spool, depositItemId("seat-x", legacyAlarm.depositId))).toBeUndefined();
    expect(await resolve()).toBe(0);
  });

  it("files incidents with an alarm key naming the deployed service", () => {
    const incident = incidentDeposit({ kind: "rolled-back", target: "2".repeat(40), from: "1".repeat(40), why: "no /health", at: "2031-03-05T12:00:00.000Z" });

    expect(incident.keys).toEqual(["deploy-incident", "alarm:deploy-incident:titan-factory"]);
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerOp } from "@titan-design/owner-queue";
import { afterEach, describe, expect, it } from "vitest";
import type { Outcome } from "../console-action/outcome.js";
import { deployLockPath } from "../deploy-lock.js";
import { deployHoldPath, deployPausePath, type DeployPause } from "../deploy-pause.js";
import { systemPauseClearPorts } from "../deploy-ports.js";
import { ownerOpsLedger, runLogged, type OwnerOpsLedger } from "./ledger.js";
import { clearPause } from "./pause-clear.js";

const P = "2026-10-18T12:00:00.000Z";
const P2 = "2026-10-18T13:30:00.000Z";
const TARGET = "f".repeat(40);
const CONFIRM = `action:${"d".repeat(64)}`;
const NOW = () => Date.parse("2026-10-18T14:00:00.000Z");

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface World {
  stateDir: string;
  ledger: OwnerOpsLedger;
  /** One tap as the route runs it: inside `runLogged`, so the ledger sees `started` before the effect. */
  tap(op?: OwnerOp): Promise<Outcome>;
}

function world(): World {
  const stateDir = mkdtempSync(join(tmpdir(), "factory-pause-clear-"));
  dirs.push(stateDir);
  const ledger = ownerOpsLedger(stateDir);
  const deploy = { stateDir, ports: systemPauseClearPorts() };
  const tap = (op: OwnerOp = { kind: "deploy-pause-clear", pausedAt: P, target: TARGET }) =>
    runLogged(ledger, { actionId: "act-1", op, now: NOW }, () => clearPause("act-1", { op, confirmEvent: CONFIRM }, { deploy, ledger }));
  return { stateDir, ledger, tap };
}

function pauseAt(stateDir: string, pausedAt: string, target = TARGET): void {
  const pause: DeployPause = { pausedAt, target, from: "e".repeat(40), why: "the restarted build failed its watch window", rollback: "verified" };
  writeFileSync(deployPausePath(stateDir), `${JSON.stringify(pause, null, 2)}\n`);
}

const holdByHand = (stateDir: string): void => writeFileSync(deployHoldPath(stateDir), JSON.stringify({ heldAt: P, reason: "synthetic hold while a fix lands" }));

describe("deploy-pause-clear", () => {
  it("clears the pause that still names the record's pausedAt and target, and releases the deploy lock", async () => {
    const w = world();
    pauseAt(w.stateDir, P);

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "pause-cleared", clearedPause: P, stillHeld: null });
    expect(existsSync(deployPausePath(w.stateDir))).toBe(false);
    expect(existsSync(deployLockPath(w.stateDir))).toBe(false);
    expect((await w.ledger.read("act-1")).map((entry) => entry.phase)).toEqual(["started", "done"]);
  });

  it("answers moved and leaves a newer pause P2 in place", async () => {
    const w = world();
    pauseAt(w.stateDir, P2);
    const before = readFileSync(deployPausePath(w.stateDir), "utf8");

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "moved", currentPause: P2 });
    expect(readFileSync(deployPausePath(w.stateDir), "utf8")).toBe(before);
  });

  it("answers moved for a pause at the same time over another target", async () => {
    const w = world();
    pauseAt(w.stateDir, P, "0".repeat(40));

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "moved", currentPause: P });
    expect(existsSync(deployPausePath(w.stateDir))).toBe(true);
  });

  it("refuses while a deployer holds the deploy lock, and the pause stays", async () => {
    const w = world();
    pauseAt(w.stateDir, P);
    writeFileSync(deployLockPath(w.stateDir), String(process.pid));

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "refused", reason: "deploying", detail: `a deployer is running (pid ${process.pid}); tap again once it ends` });
    expect(existsSync(deployPausePath(w.stateDir))).toBe(true);
  });

  it("clears the failure pause but never the manual hold beside it, and says deploys stay held", async () => {
    const w = world();
    pauseAt(w.stateDir, P);
    holdByHand(w.stateDir);

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "pause-cleared", clearedPause: P, stillHeld: "synthetic hold while a fix lands" });
    expect(existsSync(deployHoldPath(w.stateDir))).toBe(true);
  });

  it("answers gone for a manual hold with no failure pause, and the hold stays", async () => {
    const w = world();
    holdByHand(w.stateDir);

    const outcome = await w.tap();

    expect(outcome).toMatchObject({ outcome: "gone" });
    expect(existsSync(deployHoldPath(w.stateDir))).toBe(true);
  });

  it("answers already on a replay after done", async () => {
    const w = world();
    pauseAt(w.stateDir, P);
    await w.tap();

    const replay = await w.tap();

    expect(replay).toEqual({ outcome: "already", clearedPause: P });
  });

  it("answers moved on a replay once a newer pause has been written since the clear", async () => {
    const w = world();
    pauseAt(w.stateDir, P);
    await w.tap();
    pauseAt(w.stateDir, P2);

    const replay = await w.tap();

    expect(replay).toEqual({ outcome: "moved", currentPause: P2 });
    expect(existsSync(deployPausePath(w.stateDir))).toBe(true);
  });
});

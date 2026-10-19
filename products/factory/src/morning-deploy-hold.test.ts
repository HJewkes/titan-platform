import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { clearManualHold, deployHoldPath, describeManualHold, deployPausePath, readDeployHolds, writeManualHold, type ManualState } from "./deploy-pause.js";
import { nodeMorningHoldPorts as ports, reconcileMorningHold, syncMorningHold } from "./morning-deploy-hold.js";

const NOW = "2026-01-02T03:04:05.000Z";
const EARLIER = "2026-01-01T00:00:00.000Z";
const ITEM = { id: "morning:seat-a:7", reason: "copy the widget db first" };
const OTHER = { id: "morning:seat-b:2", reason: "vendor window" };
const PAUSE = `${JSON.stringify({ pausedAt: EARLIER, target: "a".repeat(40), from: "b".repeat(40), why: "health failed", rollback: "verified" }, null, 2)}\n`;
const OWNER_HOLD = { heldAt: EARLIER, reason: "owner hold for a migration" };

const morningSet = (source: string): ManualState => ({ set: true, hold: { heldAt: EARLIER, reason: `Morning ${source}: old`, source } });
const handSet: ManualState = { set: true, hold: OWNER_HOLD };
const reconcile = (manual: ManualState, items: (typeof ITEM)[] | undefined, emptyBefore = 1) => reconcileMorningHold({ manual, items, emptyBefore, now: NOW });

describe("reconcileMorningHold", () => {
  it("sets a hold named for the first item when none stands", () => {
    expect(reconcile({ set: false }, [ITEM, OTHER])).toEqual({
      kind: "set",
      hold: { heldAt: NOW, reason: "Morning morning:seat-a:7: copy the widget db first", source: ITEM.id },
    });
  });

  it("keeps a Morning hold whose item still stands, without rewriting it", () => {
    expect(reconcile(morningSet(ITEM.id), [OTHER, ITEM]).kind).toBe("keep");
  });

  it("moves a Morning hold whose item is gone to the first item left", () => {
    expect(reconcile(morningSet("morning:seat-a:1"), [OTHER])).toEqual({
      kind: "replace",
      from: "morning:seat-a:1",
      hold: { heldAt: NOW, reason: "Morning morning:seat-b:2: vendor window", source: OTHER.id },
    });
  });

  it("never writes over a hold set by hand or one that does not parse", () => {
    expect(reconcile(handSet, [ITEM]).kind).toBe("keep");
    expect(reconcile({ set: true, hold: undefined }, [ITEM]).kind).toBe("keep");
  });

  it("clears a Morning hold on the second read with no item, not the first", () => {
    expect(reconcile(morningSet(ITEM.id), [], 0).kind).toBe("keep");
    expect(reconcile(morningSet(ITEM.id), [], 1)).toEqual({ kind: "clear", source: ITEM.id });
  });

  it("never clears a hold set by hand or one that does not parse", () => {
    expect(reconcile(handSet, [], 5).kind).toBe("keep");
    expect(reconcile({ set: true, hold: undefined }, [], 5).kind).toBe("keep");
  });

  it("keeps any hold when the queue could not be read", () => {
    expect(reconcile(morningSet(ITEM.id), undefined, 5).kind).toBe("keep");
    expect(reconcile({ set: false }, undefined).kind).toBe("keep");
  });
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function world() {
  const root = mkdtempSync(join(tmpdir(), "factory-morning-hold-"));
  dirs.push(root);
  const stateDir = join(root, "state");
  const queuesDir = join(root, "queues");
  mkdirSync(stateDir);
  mkdirSync(queuesDir);
  const seat = (items: string[]) => writeFileSync(join(queuesDir, "seat-a.md"), ["## Morning queue (owner only)", ...items, ""].join("\n"));
  const sync = (emptyBefore = 0) => syncMorningHold(ports, { stateDir, queuesDir, now: NOW, emptyBefore });
  const hold = () => z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(deployHoldPath(stateDir), "utf8")));
  return { stateDir, queuesDir, seat, sync, hold };
}

const HOLD_ITEM = "7. DEPLOY HOLD: copy the widget db first. One-way.";

describe("syncMorningHold", () => {
  it("leaves the failure pause byte-identical and writes nothing when no item stands", () => {
    const w = world();
    w.seat(["3. Pick a colour. Two-way."]);
    writeFileSync(deployPausePath(w.stateDir), PAUSE);

    w.sync(3);

    expect(readFileSync(deployPausePath(w.stateDir), "utf8")).toBe(PAUSE);
    expect(existsSync(deployHoldPath(w.stateDir))).toBe(false);
  });

  it("writes only the manual hold when an item stands beside a failure pause", () => {
    const w = world();
    w.seat([HOLD_ITEM]);
    writeFileSync(deployPausePath(w.stateDir), PAUSE);

    const result = w.sync();

    expect(result).toMatchObject({ action: { kind: "set" }, emptyReads: 0 });
    expect(w.hold()).toEqual({ heldAt: NOW, reason: "Morning morning:seat-a:7: copy the widget db first", source: "morning:seat-a:7" });
    expect(readFileSync(deployPausePath(w.stateDir), "utf8")).toBe(PAUSE);
  });

  it("clears only the manual hold after two empty reads, and the failure pause still holds", () => {
    const w = world();
    w.seat([HOLD_ITEM]);
    writeFileSync(deployPausePath(w.stateDir), PAUSE);
    w.sync();
    w.seat([]);

    const first = w.sync(0);
    expect(existsSync(deployHoldPath(w.stateDir))).toBe(true);
    const second = w.sync(first.emptyReads);

    expect(second.action).toEqual({ kind: "clear", source: "morning:seat-a:7" });
    expect(existsSync(deployHoldPath(w.stateDir))).toBe(false);
    expect(readFileSync(deployPausePath(w.stateDir), "utf8")).toBe(PAUSE);
    expect(readDeployHolds(ports, w.stateDir).held).toBe(true);
  });

  it("keeps a Morning hold while the queue dir is missing, and resets the empty count", () => {
    const w = world();
    w.seat([HOLD_ITEM]);
    w.sync();
    rmSync(w.queuesDir, { recursive: true });

    const result = w.sync(5);

    expect(result).toMatchObject({ action: { kind: "keep" }, emptyReads: 0 });
    expect(w.hold()).toMatchObject({ source: "morning:seat-a:7" });
  });

  it("keeps the owner's hold when an item appears and when it goes", () => {
    const w = world();
    writeManualHold(ports, w.stateDir, OWNER_HOLD);
    w.seat([HOLD_ITEM]);
    w.sync();
    w.seat([]);
    w.sync(5);

    expect(w.hold()).toEqual(OWNER_HOLD);
  });
});

describe("clearManualHold", () => {
  it("removes nothing when the hold on disk carries another source or none", () => {
    const w = world();
    writeManualHold(ports, w.stateDir, OWNER_HOLD);

    expect(clearManualHold(ports, w.stateDir, "morning:seat-a:7")).toBe(false);
    writeManualHold(ports, w.stateDir, { ...OWNER_HOLD, source: "morning:seat-b:2" });
    expect(clearManualHold(ports, w.stateDir, "morning:seat-a:7")).toBe(false);

    expect(w.hold()).toEqual({ ...OWNER_HOLD, source: "morning:seat-b:2" });
  });
});

describe("writeManualHold", () => {
  it("fails a create-only write over a standing hold and keeps the owner's reason", () => {
    const w = world();
    writeManualHold(ports, w.stateDir, OWNER_HOLD);

    const failed = writeManualHold(ports, w.stateDir, { heldAt: NOW, reason: "Morning item", source: ITEM.id }, { exclusive: true });

    expect(failed).toBe("deploy-hold.json already exists");
    expect(w.hold()).toEqual(OWNER_HOLD);
  });
});

describe("describeManualHold", () => {
  it("names the Morning item and how to lift it, and leaves a hand-set hold's line as it was", () => {
    expect(describeManualHold(morningSet(ITEM.id))).toBe(
      `deploys are held by hand since ${EARLIER}: Morning morning:seat-a:7: old (Morning item morning:seat-a:7; remove the item to clear)`,
    );
    expect(describeManualHold(handSet)).toBe(`deploys are held by hand since ${EARLIER}: owner hold for a migration`);
  });
});

describe("deploy-hold.json across builds", () => {
  const PreSourceSchema = z.object({ heldAt: z.string(), reason: z.string().min(1) });

  it("holds on a file written before the source key, and an older build still parses one with it", () => {
    const w = world();
    writeFileSync(deployHoldPath(w.stateDir), `${JSON.stringify(OWNER_HOLD)}\n`);
    expect(readDeployHolds(ports, w.stateDir).manual).toEqual({ set: true, hold: OWNER_HOLD });

    w.seat([HOLD_ITEM]);
    rmSync(deployHoldPath(w.stateDir));
    w.sync();

    expect(PreSourceSchema.safeParse(w.hold()).success).toBe(true);
  });
});

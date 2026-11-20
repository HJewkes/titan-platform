import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerOp } from "@titan-design/owner-queue";
import { afterEach, describe, expect, it } from "vitest";
import { configRef, type ConfigRef } from "../config-ref.js";
import type { Outcome } from "../console-action/outcome.js";
import { setFactoryConfig, type FactoryConfigFile } from "./config-set.js";
import { ownerOpsLedger, runLogged, type OwnerOpsLedger } from "./ledger.js";

const CONFIRM = `action:${"d".repeat(64)}`;
const NOW = () => Date.parse("2026-11-01T09:00:00.000Z");
const STARTING = { shepherd: { spawnGate: { load5: 40, windowMs: 60_000 } } };
const SET_LOAD: OwnerOp = { kind: "factory-config-set", path: "shepherd.spawnGate.load5", value: 30, expectFrom: 40 };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface World {
  configFile: string;
  stateDir: string;
  ref: ConfigRef;
  ledger: OwnerOpsLedger;
  /** One tap as the route runs it: inside `runLogged`, so the ledger sees `started` before the effect. */
  tap(op?: OwnerOp, rename?: FactoryConfigFile["rename"]): Promise<Outcome>;
}

function world(config: object = STARTING): World {
  const root = mkdtempSync(join(tmpdir(), "factory-config-set-"));
  dirs.push(root);
  const configFile = join(root, "config.json");
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const ref = configRef(configFile, NOW, { warn: () => undefined });
  const ledger = ownerOpsLedger(root);
  const tap = (op: OwnerOp = SET_LOAD, rename?: FactoryConfigFile["rename"]) =>
    runLogged(ledger, { actionId: "act-1", op, now: NOW }, () =>
      setFactoryConfig("act-1", { op, confirmEvent: CONFIRM }, { factoryConfig: { ref, path: configFile, stateDir: root, rename }, ledger }),
    );
  return { configFile, stateDir: root, ref, ledger, tap };
}

const backups = (w: World): string[] => readdirSync(w.stateDir).filter((name) => name.includes(".bak-console-"));
const revisionsOf = (w: World): unknown[] => {
  const path = join(w.stateDir, "config.revisions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown) : [];
};

describe("factory-config-set", () => {
  it("answers moved on a hand edit after prepare and leaves the bytes unchanged", async () => {
    const w = world();
    writeFileSync(w.configFile, `${JSON.stringify({ shepherd: { spawnGate: { load5: 50, windowMs: 60_000 } } }, null, 2)}\n`);
    const handEdited = readFileSync(w.configFile, "utf8");

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "moved", currentValue: 50 });
    expect(readFileSync(w.configFile, "utf8")).toBe(handEdited);
    expect(backups(w)).toEqual([]);
  });

  it("leaves the file byte-identical and writes no backup when the result fails FactoryConfigSchema", async () => {
    const w = world();
    const before = readFileSync(w.configFile, "utf8");

    const outcome = await w.tap({ kind: "factory-config-set", path: "shepherd.review.maxConcurrent", value: 3 });

    expect(outcome).toMatchObject({ outcome: "refused", reason: "payload" });
    expect(readFileSync(w.configFile, "utf8")).toBe(before);
    expect(backups(w)).toEqual([]);
    expect(revisionsOf(w)).toEqual([]);
  });

  it("refuses a path no editable row allows, and a value its row rejects", async () => {
    const w = world();
    const before = readFileSync(w.configFile, "utf8");

    const notEditable = await w.tap({ kind: "factory-config-set", path: "shepherd.consoleAnswers.actionsDir", value: "/tmp/synthetic" });
    const invalid = await w.tap({ kind: "factory-config-set", path: "shepherd.spawnGate.load5", value: 0, expectFrom: 40 });

    expect(notEditable).toMatchObject({ outcome: "refused", reason: "class" });
    expect(invalid).toMatchObject({ outcome: "refused", reason: "payload" });
    expect(readFileSync(w.configFile, "utf8")).toBe(before);
  });

  it("writes the backup, the revision line and the new file, and the ref reads the new value", async () => {
    const w = world();
    const before = readFileSync(w.configFile, "utf8");

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "config-set", path: "shepherd.spawnGate.load5", value: 30 });
    expect(readFileSync(join(w.stateDir, "config.json.bak-console-dddddddd"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(w.configFile, "utf8"))).toEqual({ shepherd: { spawnGate: { load5: 30, windowMs: 60_000 } } });
    expect(revisionsOf(w)).toEqual([expect.objectContaining({ actionId: "act-1", path: "shepherd.spawnGate.load5", from: 40, to: 30, fromSha: expect.stringMatching(/^[0-9a-f]{64}$/), toSha: w.ref.stamp().sha })]);
    expect(w.ref.get().shepherd?.spawnGate?.load5).toBe(30);
  });

  it("answers already on a replay whose ledger has done, and writes nothing more", async () => {
    const w = world();
    await w.tap();
    const after = readFileSync(w.configFile, "utf8");

    const replay = await w.tap();

    expect(replay).toEqual({ outcome: "already", path: "shepherd.spawnGate.load5", value: 30 });
    expect(readFileSync(w.configFile, "utf8")).toBe(after);
    expect(revisionsOf(w)).toHaveLength(1);
  });

  it("leaves the old file whole when the write throws between the temp file and the rename", async () => {
    const w = world();
    const before = readFileSync(w.configFile, "utf8");
    const failingRename = () => Promise.reject(new Error("synthetic rename failure"));

    await expect(w.tap(SET_LOAD, failingRename)).rejects.toThrow("synthetic rename failure");

    expect(readFileSync(w.configFile, "utf8")).toBe(before);
    expect(readdirSync(w.stateDir).filter((name) => name.includes(".tmp-console-"))).toEqual([]);
    expect(revisionsOf(w)).toEqual([]);
    expect(w.ref.get().shepherd?.spawnGate?.load5).toBe(40);
  });

  it("refuses when serve has no config file wired", async () => {
    const w = world();
    const outcome = await setFactoryConfig("act-2", { op: SET_LOAD, confirmEvent: CONFIRM }, { factoryConfig: undefined, ledger: w.ledger });

    expect(outcome).toMatchObject({ outcome: "refused", reason: "config-unavailable" });
  });
});

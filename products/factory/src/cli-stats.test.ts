import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import { openDatabase } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { openFactoryHost } from "./host.js";
import { factoryRoutes, factoryWorkflows } from "./workflows.js";

function capture(): { out: string[]; err: string[]; io: Parameters<typeof runCli>[1] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {} } };
}

describe("shepherd stats verb", () => {
  it("prints an empty report for a ledger with no runs", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const { out, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--json"], io);

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ merges: [], ownerFriction: [], stageTimes: [], reviewCauses: [] });
  });

  it("prints only the review causes with --rereviews", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const json = capture();
    const text = capture();

    const codes = [await runCli(["--db", db, "shepherd", "stats", "--rereviews", "--json"], json.io), await runCli(["--db", db, "shepherd", "stats", "--rereviews"], text.io)];

    expect(codes).toEqual([0, 0]);
    expect(JSON.parse(json.out.join(""))).toEqual({ reviewCauses: [] });
    expect(text.out.join("")).toBe("no reviews in range\n");
  });

  it("reports owner touches and the wait per gate kind from the gate store", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const store = openDatabase(db);
    let clock = Date.parse("2026-10-07T08:00:00Z");
    const gates = new SqliteGateStore(store, { migrate: false, now: () => clock });
    gates.create({ id: "run-1/approve-merge:0", prompt: "p" });
    clock += 3 * 3_600_000;
    gates.resolve("run-1/approve-merge:0", {}, { class: "owner-terminal", id: "owner", channel: "terminal" });
    store.close();
    const { out, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--json", "--from", "2026-10-07", "--to", "2026-10-07"], io);

    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).ownerFriction).toEqual([{ day: "2026-10-07", ownerTouches: 1, kinds: [{ kind: "approve-merge", gates: 1, medianHours: 3, maxHours: 3 }] }]);
  });

  it("refuses a malformed date", async () => {
    const { err, io } = capture();

    const code = await runCli(["--db", ":memory:", "shepherd", "stats", "--from", "yesterday"], io);

    expect(code).toBe(2);
    expect(err.join("")).toContain("YYYY-MM-DD");
  });

  it("prints one line and exits 2 when the store is missing", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "absent.db");
    const { err, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats"], io);

    expect(code).toBe(2);
    expect(err.join("").trimEnd().split("\n")).toHaveLength(1);
    expect(err.join("")).toContain("cannot read the store");
  });
});

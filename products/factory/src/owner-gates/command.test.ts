import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import { openDatabase } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../cli.js";
import { openFactoryHost } from "../host.js";
import { factoryRoutes, factoryWorkflows } from "../workflows.js";

const OWNER = { class: "owner-terminal", id: "owner", channel: "terminal" } as const;

/** A factory store holding 20 owner-merged authority gates (D4) and one ci-failed gate (D16) the owner abandoned. */
function seededStore(): string {
  const db = join(mkdtempSync(join(tmpdir(), "owner-gates-")), "factory.sqlite3");
  openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
  const store = openDatabase(db);
  let clock = Date.now() - 3 * 3_600_000;
  const gates = new SqliteGateStore(store, { migrate: false, now: () => clock });
  for (let i = 0; i < 20; i++) gates.create({ id: `run-${i}/approve-merge:0`, prompt: "Merge? Policy authority/MRG-AU: owner merges" });
  gates.create({ id: "run-ci/ci-failed:0", prompt: "CI failed" });
  clock += 2 * 3_600_000;
  for (let i = 0; i < 20; i++) gates.resolve(`run-${i}/approve-merge:0`, { decision: "merge" }, OWNER);
  gates.resolve("run-ci/ci-failed:0", { decision: "abandon" }, OWNER);
  store.close();
  return db;
}

function capture(inbox: string) {
  const out: string[] = [];
  const io: CliIo = { stdout: (text) => void out.push(text), stderr: (text) => void out.push(text), env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "cfg-")), TITAN_CONSOLE_INBOX_DIR: inbox } };
  return { out, io };
}

describe("titan-factory owner-gates report", () => {
  it("prints the classes and grants as JSON and files no card without --deposit", async () => {
    const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
    const { out, io } = capture(inbox);

    const code = await runCli(["--db", seededStore(), "owner-gates", "report", "--json"], io);

    expect(code).toBe(0);
    const report = JSON.parse(out.join(""));
    expect(report.classes).toEqual([
      expect.objectContaining({ class: "D4", answered: 20, approved: 20, rate: 1, medianWaitHours: 2 }),
      expect.objectContaining({ class: "D16", answered: 1, approved: 0 }),
    ]);
    expect(report.flagged).toEqual([expect.objectContaining({ class: "D4", held: [] })]);
    expect(report.grants).toEqual([]);
    expect(readdirSync(inbox)).toEqual([]);
  });

  it("files one card per flagged class with --deposit, and none again on a re-run", async () => {
    const db = seededStore();
    const inbox = mkdtempSync(join(tmpdir(), "inbox-"));

    const first = capture(inbox);
    await runCli(["--db", db, "owner-gates", "report", "--deposit"], first.io);
    const again = capture(inbox);
    await runCli(["--db", db, "owner-gates", "report", "--deposit"], again.io);

    expect(readdirSync(inbox)).toHaveLength(1);
    expect(first.out.join("")).toMatch(/deposited D4 /);
    expect(again.out.join("")).toMatch(/already filed D4 /);
  });

  it("files a card that claims no audit, since the report verb consults none", async () => {
    const inbox = mkdtempSync(join(tmpdir(), "inbox-"));

    await runCli(["--db", seededStore(), "owner-gates", "report", "--deposit"], capture(inbox).io);

    const card = readFileSync(join(inbox, readdirSync(inbox)[0]!), "utf8");
    expect(card).not.toMatch(/audit sample found no/);
    expect(card).toContain("No audit result was consulted");
  });
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { AncestryProbe } from "../build-ancestry.js";
import { runCli } from "../cli.js";
import type { CliDeps, CliIo } from "../cli-types.js";
import { openFactoryHost } from "../host.js";
import { SHEPHERD_WORKFLOW } from "../shepherd/services.js";
import { auditRun, HOUR, step } from "../test-support/owner-gate-audit.js";
import { factoryRoutes, factoryWorkflows } from "../workflows.js";
import { JudgeUnavailable, type AuditJudge } from "./audit-judge.js";

const OWNER = { class: "owner-terminal", id: "owner", channel: "terminal" } as const;
const W41_TUESDAY = Date.parse("2026-10-06T08:00:00Z");
const AFTER_W41 = Date.parse("2026-10-13T06:00:00Z");
const MERGE_SHA = "1111111111111111111111111111111111111111";

/** A factory store with `count` owner-merged gates resolved in 2026-W41; run-0 merged MERGE_SHA. */
function seededStore(count: number): string {
  const db = join(mkdtempSync(join(tmpdir(), "owner-gates-audit-")), "factory.sqlite3");
  openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
  const store = openDatabase(db);
  let clock = W41_TUESDAY;
  const gates = new SqliteGateStore(store, { migrate: false, now: () => clock });
  for (let i = 0; i < count; i++) gates.create({ id: `run-${i}/approve-merge:0`, prompt: "Merge? Policy authority/MRG-AU: owner merges" });
  clock += 2 * HOUR;
  for (let i = 0; i < count; i++) gates.resolve(`run-${i}/approve-merge:0`, { decision: "merge" }, OWNER);
  const landed = auditRun("run-0", { "sh-landed": step("sh-landed", clock + HOUR, { mergeSha: MERGE_SHA }) });
  new WorkflowRunStore(store).create({ ...landed, workflowName: SHEPHERD_WORKFLOW, params: { repo: "acme/widgets", pr: "7" }, completedAt: new Date(clock + HOUR).toISOString() });
  store.close();
  return db;
}

interface Harness {
  out: string[];
  err: string[];
  io: CliIo;
  activeRoot: string;
  stateDir: string;
}

function harness(): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const activeRoot = mkdtempSync(join(tmpdir(), "active-root-"));
  const stateHome = mkdtempSync(join(tmpdir(), "state-"));
  const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "cfg-")), XDG_STATE_HOME: stateHome, ACTIVE_ROOT: activeRoot, TITAN_CONSOLE_INBOX_DIR: mkdtempSync(join(tmpdir(), "inbox-")) };
  return { out, err, activeRoot, stateDir: join(stateHome, "titan-factory"), io: { stdout: (text) => void out.push(text), stderr: (text) => void err.push(text), env } };
}

const echoJudge: AuditJudge = async ({ gateId }) => ({ stamp: "did-work", note: `read ${gateId}` });
const noAncestor: AncestryProbe = async () => false;

function depsWith(audit: { judge?: AuditJudge; isAncestor?: AncestryProbe; now?: () => number }): CliDeps {
  return { workflows: factoryWorkflows, routes: factoryRoutes, ownerGatesAudit: { judge: echoJudge, isAncestor: noAncestor, now: () => AFTER_W41, ...audit } };
}

function writeIncidentLog(stateDir: string, lines: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "deploy-incidents.jsonl"), lines);
}

const sampledIds = (markdown: string): string[] => [...markdown.matchAll(/^### \d+\. (\S+)$/gm)].map((match) => match[1]!);
const auditFile = (h: Harness, week: string): string => join(h.activeRoot, "titan-platform", "sources", `owner-gate-audit-${week}.md`);

describe("titan-factory owner-gates audit", () => {
  it("draws the same five gates for the same week on every run, and writes nothing on --dry-run", async () => {
    const db = seededStore(8);
    const first = harness();
    const again = harness();

    await runCli(["--db", db, "owner-gates", "audit", "--week", "2026-W41", "--dry-run"], first.io, depsWith({}));
    await runCli(["--db", db, "owner-gates", "audit", "--week", "2026-W41", "--dry-run"], again.io, depsWith({}));

    expect(sampledIds(first.out.join(""))).toHaveLength(5);
    expect(sampledIds(again.out.join(""))).toEqual(sampledIds(first.out.join("")));
    expect(first.out.join("")).toContain("owner-resolved gates in the week: 8; sampled: 5");
    expect(existsSync(join(first.activeRoot, "titan-platform"))).toBe(false);
  });

  it("samples every gate when the week has fewer than five", async () => {
    const h = harness();

    await runCli(["--db", seededStore(3), "owner-gates", "audit", "--week", "2026-W41", "--dry-run"], h.io, depsWith({}));

    expect(sampledIds(h.out.join("")).sort()).toEqual(["run-0/approve-merge:0", "run-1/approve-merge:0", "run-2/approve-merge:0"]);
  });

  it("reports incidents unknown when the factory state dir holds no incident log", async () => {
    const h = harness();

    await runCli(["--db", seededStore(1), "owner-gates", "audit", "--week", "2026-W41", "--dry-run"], h.io, depsWith({}));

    expect(h.out.join("")).toContain("incidents unknown");
    expect(h.out.join("")).not.toContain("no linked incident");
  });

  it("reads the incident log from the factory state dir and reports unknown when ancestry cannot answer", async () => {
    const readable = harness();
    const unreadable = harness();
    const incident = `${JSON.stringify({ kind: "rolled-back", target: "2".repeat(40), from: "3".repeat(40), why: "health failed", at: new Date(W41_TUESDAY + 4 * HOUR).toISOString() })}\n`;
    writeIncidentLog(readable.stateDir, incident);
    writeIncidentLog(unreadable.stateDir, incident);
    const db = seededStore(1);

    await runCli(["--db", db, "owner-gates", "audit", "--week", "2026-W41", "--dry-run"], readable.io, depsWith({}));
    await runCli(["--db", db, "owner-gates", "audit", "--week", "2026-W41", "--dry-run"], unreadable.io, depsWith({ isAncestor: async () => ({ unknown: "missing object" }) }));

    expect(readable.out.join("")).toContain("no linked incident");
    expect(unreadable.out.join("")).toContain("incidents unknown");
  });

  it("still writes the file when the judge fails, with judge unavailable on that gate", async () => {
    const h = harness();
    const failing: AuditJudge = () => Promise.reject(new JudgeUnavailable("rate_limited", "out of quota"));

    const code = await runCli(["--db", seededStore(2), "owner-gates", "audit", "--week", "2026-W41"], h.io, depsWith({ judge: failing }));

    expect(code).toBe(0);
    const written = readFileSync(auditFile(h, "2026-W41"), "utf8");
    expect(written.match(/judge unavailable: rate_limited/g)).toHaveLength(2);
    expect(h.out.join("")).toContain(auditFile(h, "2026-W41"));
  });

  it("refuses to replace a written week without --force", async () => {
    const db = seededStore(1);
    const h = harness();
    await runCli(["--db", db, "owner-gates", "audit", "--week", "2026-W41"], h.io, depsWith({}));

    const code = await runCli(["--db", db, "owner-gates", "audit", "--week", "2026-W41"], h.io, depsWith({}));

    expect(code).toBe(1);
    expect(h.err.join("")).toContain("pass --force");
  });
});

describe("titan-factory owner-gates weekly", () => {
  it("audits the previous ISO week, then files the demotion card with that audit consulted", async () => {
    const h = harness();
    const inbox = h.io.env.TITAN_CONSOLE_INBOX_DIR!;

    const code = await runCli(["--db", seededStore(20), "owner-gates", "weekly"], h.io, depsWith({ now: () => AFTER_W41 }));

    expect(code).toBe(0);
    expect(readdirSync(join(h.activeRoot, "titan-platform", "sources"))).toEqual(["owner-gate-audit-2026-W41.md"]);
    const cards = readdirSync(inbox);
    expect(cards).toHaveLength(1);
    expect(readFileSync(join(inbox, cards[0]!), "utf8")).toContain("The audit sample found no revert, red main or incident in it.");
  });

  it("still reports when the previous week's audit file is already written", async () => {
    const db = seededStore(20);
    const h = harness();
    await runCli(["--db", db, "owner-gates", "audit", "--week", "2026-W41"], h.io, depsWith({}));

    const code = await runCli(["--db", db, "owner-gates", "weekly"], h.io, depsWith({ now: () => AFTER_W41 }));

    expect(code).toBe(0);
    expect(readdirSync(h.io.env.TITAN_CONSOLE_INBOX_DIR!)).toHaveLength(1);
  });
});

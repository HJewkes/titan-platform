import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowStatus } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { factoryMigrations } from "../host.js";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import { MergeOrder, blockers, fileRules, overlapping, type MergeOrderRule, type Reservation } from "./merge-order.js";

const REPO = "hjewkes/titan-platform";
const RULE: MergeOrderRule = { enabled: true, ttlMinutes: 120, ignore: [".changeset/**"] };
const AT = Date.parse("2026-10-23T10:00:00.000Z");
const minutes = (n: number): string => new Date(AT + n * 60_000).toISOString();

const reservation = (runId: string, pr: number, paths: string[], since = minutes(0)): Reservation => ({ repo: REPO, runId, pr, headSha: `head-${pr}`, baseSha: "base-1", paths, ahead: [], since, reason: "conflicted" });
const everyoneDrives = (): boolean => true;

describe("which paths two PRs overlap on", () => {
  it("never counts changeset files or generated files such as CAPABILITIES.md", () => {
    expect(overlapping(REPO, [".changeset/a.md", "CAPABILITIES.md"], [".changeset/b.md", ".changeset/a.md", "CAPABILITIES.md"], RULE)).toEqual([]);
  });

  it("counts products/explainer/CAPABILITY.md changed on both sides", () => {
    expect(overlapping(REPO, ["products/explainer/CAPABILITY.md", "src/a.ts"], ["products/explainer/CAPABILITY.md", "src/b.ts"], RULE)).toEqual(["products/explainer/CAPABILITY.md"]);
  });

  it("ships the titan-platform rule turned on", () => {
    expect(fileRules(REPO)).toEqual({ enabled: true, ttlMinutes: 120, ignore: [".changeset/**"] });
    expect(fileRules("octo/other")).toBeUndefined();
  });
});

describe("which reservations a PR waits behind", () => {
  it("waits behind an overlapping reservation and names the shared paths", () => {
    const found = blockers({ repo: REPO, runId: "run-y", paths: ["README.md", "src/y.ts"] }, [reservation("run-x", 2301, ["README.md"])], RULE, AT, everyoneDrives);

    expect(found.map((b) => [b.reservation.pr, b.shared])).toEqual([[2301, ["README.md"]]]);
  });

  it("never waits behind its own reservation", () => {
    expect(blockers({ repo: REPO, runId: "run-x", paths: ["README.md"] }, [reservation("run-x", 2301, ["README.md"])], RULE, AT, everyoneDrives)).toEqual([]);
  });

  it("lets the earlier of two overlapping reservations go and holds the later one", () => {
    const both = [reservation("run-b", 2, ["README.md"], minutes(5)), reservation("run-a", 1, ["README.md"], minutes(1))];

    expect(blockers({ repo: REPO, runId: "run-a", paths: ["README.md"] }, both, RULE, AT + 10 * 60_000, everyoneDrives)).toEqual([]);
    expect(blockers({ repo: REPO, runId: "run-b", paths: ["README.md"] }, both, RULE, AT + 10 * 60_000, everyoneDrives).map((b) => b.reservation.pr)).toEqual([1]);
  });

  it("stops waiting once the reservation is older than the TTL or its run no longer drives", () => {
    const held = [reservation("run-x", 2301, ["README.md"])];
    const self = { repo: REPO, runId: "run-y", paths: ["README.md"] };

    expect(blockers(self, held, RULE, AT + 120 * 60_000, everyoneDrives)).toEqual([]);
    expect(blockers(self, held, RULE, AT, () => false)).toEqual([]);
  });

  it("never waits behind a reservation that let it merge first", () => {
    const graced = [{ ...reservation("run-x", 2301, ["README.md"]), ahead: ["run-z"] }];

    expect(blockers({ repo: REPO, runId: "run-z", paths: ["README.md"] }, graced, RULE, AT, everyoneDrives)).toEqual([]);
  });

  it("waits behind every live reservation while its own paths are unread", () => {
    expect(blockers({ repo: REPO, runId: "run-y", paths: [], unread: true }, [reservation("run-x", 2301, ["README.md"])], RULE, AT, everyoneDrives).map((b) => b.reservation.pr)).toEqual([2301]);
  });
});

describe("the merge-order store", () => {
  function store(): { order: MergeOrder; runs: WorkflowRunStore } {
    const db = openDatabase(":memory:");
    runMigrations(db, [...factoryMigrations(), ...SHEPHERD_MIGRATIONS]);
    return { order: new MergeOrder(db), runs: new WorkflowRunStore(db) };
  }

  const run = (id: string, status: WorkflowStatus) => ({ id, workflowName: "shepherd-pr", params: { repo: REPO }, status, currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: minutes(0), completedAt: null, error: null });

  it("keeps one row per run, replaced on a repeat, and forgets it on release", () => {
    const { order } = store();
    order.reserve(reservation("run-x", 2301, ["README.md"]));
    order.reserve({ ...reservation("run-x", 2301, ["README.md", "src/x.ts"]), headSha: "head-2301b" });

    expect(order.list("HJewkes/Titan-Platform")).toEqual([{ ...reservation("run-x", 2301, ["README.md", "src/x.ts"]), headSha: "head-2301b" }]);
    expect(order.release(REPO, "run-x", { at: minutes(1) })).toBe(true);
    expect(order.release(REPO, "run-x", { at: minutes(1) })).toBe(false);
    expect(order.list(REPO)).toEqual([]);
  });

  it("counts a running run as driving and a paused or finished one as not", () => {
    const { order, runs } = store();
    runs.create(run("run-live", "running"));
    runs.create(run("run-gated", "paused"));

    expect([order.isDriving("run-live"), order.isDriving("run-gated"), order.isDriving("run-missing")]).toEqual([true, false, false]);
  });
});

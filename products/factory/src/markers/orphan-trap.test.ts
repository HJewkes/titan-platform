import { describe, expect, it } from "vitest";
import type { MarkerRow } from "./marker-store.js";
import { findOrphans, visit, type EntryLog } from "./orphan-trap.js";

const RUN = "run-1";
const RECORDED = ["ci-wait:0", "sh-await-verdict:0", "merge:0"];
const REQUIRED = new Set(["ci:green", "verdict:merge"]);

function marker(overrides: Partial<MarkerRow> = {}): MarkerRow {
  return {
    id: 1,
    item: "fixture/repo#7",
    fact: "ci:green",
    pinClass: "tree",
    pin: `${"c".repeat(40)}@e1`,
    pinSeq: null,
    expiresAt: null,
    step: "ci-wait",
    callSite: "land-fixture/ci-wait",
    version: "v+b0",
    inputDigests: {},
    reads: [],
    outputDigest: null,
    projectionDigest: null,
    runId: RUN,
    memoKey: "ci-wait:0",
    reverted: false,
    writtenAt: "2026-11-01T12:00:00.000Z",
    ...overrides,
  };
}

const freshLog = (): EntryLog => ({ runId: RUN, recorded: RECORDED, visited: new Set(), reached: 0, failClosed: false });
const allValid = (): "valid" => "valid";

describe("findOrphans", () => {
  it("a valid ci:green marker at a site before the highest reached, not visited this entry, is an orphan", () => {
    const log = freshLog();
    visit(log, "land-fixture/sh-await-verdict", "sh-await-verdict:0");

    const orphans = findOrphans(log, [marker()], REQUIRED, allValid);

    expect(orphans.map((row) => row.callSite)).toEqual(["land-fixture/ci-wait"]);
  });

  it("an entry that returns early, before the site, reports no orphan", () => {
    const log = freshLog();
    visit(log, "land-fixture/ci-wait", "ci-wait:0");
    const verdictMarker = marker({ id: 2, fact: "verdict:merge", step: "sh-await-verdict", callSite: "land-fixture/sh-await-verdict", memoKey: "sh-await-verdict:0" });

    expect(findOrphans(log, [verdictMarker], REQUIRED, allValid)).toEqual([]);
  });

  it("a memo hit at the site counts as visited", () => {
    const log = freshLog();
    visit(log, "land-fixture/ci-wait", "ci-wait:0");
    visit(log, "land-fixture/sh-await-verdict", "sh-await-verdict:0");

    expect(findOrphans(log, [marker()], REQUIRED, allValid)).toEqual([]);
    expect(log.reached).toBe(2);
  });

  it("a site marked visited by a not-after skip is not an orphan", () => {
    const log = freshLog();
    visit(log, "land-fixture/ci-wait");
    visit(log, "land-fixture/sh-await-verdict", "sh-await-verdict:0");

    expect(findOrphans(log, [marker()], REQUIRED, allValid)).toEqual([]);
  });

  it("an invalid marker, or one whose fact is outside the requirement set, is not an orphan", () => {
    const log = freshLog();
    visit(log, "land-fixture/merge", "merge:0");
    const landed = marker({ id: 3, fact: "landed", step: "merge", callSite: "land-fixture/merge-policy", memoKey: "sh-await-verdict:0" });

    expect(findOrphans(log, [marker()], REQUIRED, () => "absent")).toEqual([]);
    expect(findOrphans(log, [landed], REQUIRED, allValid)).toEqual([]);
    expect(findOrphans(log, [marker(), landed], REQUIRED, allValid).map((row) => row.id)).toEqual([1]);
  });
});

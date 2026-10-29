import { fakeSha } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import { gateEvidenceTable, type GateConclusion, type GateEvidence } from "./gate-evidence.js";

const REPO = "owner/demo-repo";
const H1 = fakeSha("lan-head-1");
const H2 = fakeSha("lan-head-2");
const SMOKE = "demo-smoke";

function table(): GateEvidence {
  const db = openDatabase(":memory:");
  runMigrations(db, SHEPHERD_MIGRATIONS);
  const evidence = gateEvidenceTable(db, () => "2026-10-28T12:00:00.000Z");
  evidence.declare(SMOKE);
  return evidence;
}

const record = (evidence: GateEvidence, head: string, conclusion: GateConclusion, gate = SMOKE) => evidence.record({ repo: REPO, head, gate, conclusion, source: "factory:demo-build" });

describe("the gate evidence table", () => {
  it("reads the newest conclusion at a head, so a red rerun replaces an earlier green", () => {
    const evidence = table();
    record(evidence, H1, "success");
    record(evidence, H1, "failure");

    const conclusion = evidence.conclusionAt(REPO, H1, SMOKE);

    expect(conclusion).toBe("failure");
  });

  it("reads nothing at a head whose only records are at another head", () => {
    const evidence = table();
    record(evidence, H1, "success");

    const conclusion = evidence.conclusionAt(REPO, H2, SMOKE);

    expect(conclusion).toBeUndefined();
  });

  it("refuses evidence for a gate never declared and for a head that is not a full sha", () => {
    const evidence = table();

    expect(() => record(evidence, H1, "success", "demo-unknown-gate")).toThrow("not a declared gate");
    expect(() => record(evidence, "abc123", "success")).toThrow("not a full head sha");
    expect(evidence.conclusionAt(REPO, H1, "demo-unknown-gate")).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEBOUNCE_S, releaseDecision } from "./release-gate.mjs";

const stale = { pending: 2, branchExists: true, branchHasTip: false, branchAgeS: DEBOUNCE_S };

describe("releaseDecision after a green main CI run", () => {
  const merged = (facts) => releaseDecision({ event: "workflow_run", ...facts }).run;

  it("publishes when no changeset is pending, however recent the Version Packages branch", () => {
    expect(merged({ ...stale, pending: 0, branchAgeS: 5 })).toBe(true);
  });

  it("opens the Version Packages PR when its branch does not exist yet", () => {
    expect(merged({ pending: 1, branchExists: false })).toBe(true);
  });

  it("skips a refresh while the branch is younger than the debounce window", () => {
    expect(merged({ ...stale, branchAgeS: DEBOUNCE_S - 1 })).toBe(false);
  });

  it("refreshes once the branch is as old as the debounce window", () => {
    expect(merged(stale)).toBe(true);
  });

  it("skips a refresh when the branch already contains the tip", () => {
    expect(merged({ ...stale, branchHasTip: true })).toBe(false);
  });
});

describe("releaseDecision on the hourly schedule", () => {
  const scheduled = (facts) => releaseDecision({ event: "schedule", tipGreen: true, ...facts }).run;

  it("never publishes, even with no changeset pending on a green tip", () => {
    expect(scheduled({ ...stale, pending: 0 })).toBe(false);
  });

  it("does nothing on a tip with no green push CI run", () => {
    expect(scheduled({ ...stale, tipGreen: false })).toBe(false);
    expect(scheduled({ ...stale, tipGreen: undefined })).toBe(false);
  });

  it("catches up a refresh the debounce skipped", () => {
    expect(scheduled(stale)).toBe(true);
  });

  it("still waits out the debounce window", () => {
    expect(scheduled({ ...stale, branchAgeS: 60 })).toBe(false);
  });
});

describe("the release workflow", () => {
  const workflow = parse(readFileSync(path.join(import.meta.dirname, "../.github/workflows/release.yml"), "utf8"));
  const job = workflow.jobs.release;
  const gateIndex = job.steps.findIndex((step) => step.id === "gate");

  it("lets a workflow_run through only for a green push CI run at the tip, and otherwise only the schedule", () => {
    const condition = job.if.replace(/\s+/g, " ").trim();

    expect(condition).toBe(
      "github.event_name == 'schedule' || ( github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.head_sha == github.sha)",
    );
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_run"]);
  });

  it("decides in the tested gate script, before any step that installs, versions or publishes", () => {
    expect(job.steps[gateIndex].run).toBe("node scripts/release-gate.mjs");
    expect(job.steps[gateIndex].env).toMatchObject({ EVENT_NAME: "${{ github.event_name }}", TIP: "${{ github.sha }}" });
    expect(job.steps.slice(0, gateIndex).map((step) => step.uses?.split("@")[0])).toEqual(["actions/create-github-app-token", "actions/checkout"]);
  });

  it("runs every step after the gate only when the gate says run", () => {
    const after = job.steps.slice(gateIndex + 1);

    expect(after.length).toBeGreaterThan(0);
    expect(after.every((step) => step.if === "steps.gate.outputs.run == 'true'")).toBe(true);
    expect(after.some((step) => step.uses?.startsWith("changesets/action@"))).toBe(true);
  });
});

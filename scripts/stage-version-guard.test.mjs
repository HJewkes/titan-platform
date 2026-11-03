import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide, parseBaseVersions, parseBumpStages, STAGE_SPEC_PATH } from "./stage-version-guard.mjs";

const BASE = { script: "x41", eval: "x24" };
const verdict = (overrides) => decide({ base: BASE, head: BASE, baseBumps: {}, headBumps: {}, ...overrides });

describe("a PR against a base with bump files", () => {
  it("passes when it only adds a bump", () => {
    const result = verdict({ baseBumps: { "TP-1": ["script"] }, headBumps: { "TP-1": ["script"], "TP-2": ["eval", "script"] } });

    expect(result.ok).toBe(true);
    expect(result.messages[0]).toContain("1 new bump");
  });

  it("fails when it edits a stage's base value, lower or higher", () => {
    const lowered = verdict({ head: { ...BASE, script: "x40" } });
    const raised = verdict({ head: { ...BASE, script: "x42" } });

    expect(lowered.ok).toBe(false);
    expect(lowered.messages[0]).toContain("base version of script changed from x41 to x40");
    expect(raised.ok).toBe(false);
  });

  it("fails when it deletes a merged bump, which hands the stage its older version back", () => {
    const result = verdict({ baseBumps: { "TP-1": ["script"] }, headBumps: {} });

    expect(result.ok).toBe(false);
    expect(result.messages[0]).toContain("bump TP-1 is on the base branch but gone");
  });

  it("fails when it reuses a merged bump's id for a different change of stages", () => {
    const result = verdict({ baseBumps: { "TP-1": ["script"] }, headBumps: { "TP-1": ["eval", "script"] } });

    expect(result.ok).toBe(false);
    expect(result.messages[0]).toContain("changed its stages");
  });

  it("fails when a new bump does not parse", () => {
    expect(verdict({ headBumps: { "TP-3": null } }).ok).toBe(false);
  });

  it("passes a stage added or dropped from the base map, which no stored key can collide with", () => {
    expect(verdict({ head: { ...BASE, extra: "e1" } }).ok).toBe(true);
    expect(verdict({ head: { script: "x41" } }).ok).toBe(true);
  });
});

it("passes against a base that predates bump files, and fails when the head lost its base map", () => {
  expect(decide({ base: null, head: BASE, baseBumps: {}, headBumps: {} }).ok).toBe(true);
  expect(decide({ base: BASE, head: null, baseBumps: {}, headBumps: {} }).ok).toBe(false);
});

it("reads the shipped base map from stage-spec.ts", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", STAGE_SPEC_PATH), "utf8");

  const versions = parseBaseVersions(source);

  expect(versions).not.toBeNull();
  expect(Object.keys(versions)).toContain("render");
});

it("reads a bump's stages in sorted order, and null for a file that is not a bump", () => {
  expect(parseBumpStages('{ "stages": ["script", "eval"], "why": "w" }')).toEqual(["eval", "script"]);
  expect(parseBumpStages("{ not json")).toBeNull();
  expect(parseBumpStages('{ "why": "w" }')).toBeNull();
});

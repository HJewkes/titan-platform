import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStageBumps, stageVersions } from "./stage-bumps.js";
import { CACHED_STAGES, type CachedStage } from "./workflow/records.js";

const BASE = Object.fromEntries(CACHED_STAGES.map((stage) => [stage, `${stage}-v1`])) as Record<CachedStage, string>;

describe("stageVersions", () => {
  it("keeps a stage no bump names at its base value, so a stored run's keys still match", () => {
    const versions = stageVersions(BASE, [{ id: "TP-1", stages: ["script"] }]);

    expect(versions.render).toBe("render-v1");
    expect(versions.script).not.toBe("script-v1");
  });

  it("gives the same version whichever order two parallel bumps merged in", () => {
    const one = { id: "TP-1", stages: ["script"] as const };
    const two = { id: "TP-2", stages: ["script", "eval"] as const };

    expect(stageVersions(BASE, [one, two])).toEqual(stageVersions(BASE, [two, one]));
  });

  it("gives two different bumps of a stage two different versions", () => {
    const first = stageVersions(BASE, [{ id: "TP-1", stages: ["script"] }]).script;
    const second = stageVersions(BASE, [{ id: "TP-2", stages: ["script"] }]).script;
    const both = stageVersions(BASE, [{ id: "TP-1", stages: ["script"] }, { id: "TP-2", stages: ["script"] }]).script;

    expect(new Set([first, second, both]).size).toBe(3);
    expect(first.startsWith("script-v1.")).toBe(true);
  });
});

describe("loadStageBumps", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const withFiles = (files: Record<string, string>): string => {
    dir = mkdtempSync(path.join(tmpdir(), "stage-bumps-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return dir;
  };

  it("reads each json file as a bump named for its file, skipping the README", () => {
    const bumps = loadStageBumps(withFiles({ "README.md": "# notes", "TP-2.json": '{ "stages": ["qa"], "why": "w" }' }));

    expect(bumps).toEqual([{ id: "TP-2", stages: ["qa"] }]);
  });

  it("refuses a bump naming a stage that does not exist", () => {
    const load = () => loadStageBumps(withFiles({ "TP-3.json": '{ "stages": ["scripts"], "why": "w" }' }));

    expect(load).toThrow(/stage bump TP-3\.json/);
  });

  it("refuses a bump id that is not letters, digits and hyphens", () => {
    expect(() => loadStageBumps(withFiles({ "TP 4.json": '{ "stages": ["qa"], "why": "w" }' }))).toThrow(/the id must be/);
  });
});

it("loads the shipped bump files", () => {
  expect(() => loadStageBumps()).not.toThrow();
});

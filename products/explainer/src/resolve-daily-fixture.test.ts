import { describe, expect, it } from "vitest";
import { slotBlocks } from "./audition-sample.js";
import { dailyScript, SIDE_QUEST_LABELS } from "./daily-script.test-helpers.js";
import { loadProfiles, profileFor } from "./profile-load.js";
import { resolveConfig, runResolveStage } from "./resolve-stage.js";
import type { ScriptV1 } from "./script-schema.js";
import { sha256 } from "./workflow/artifacts.js";
import { runStageChecks } from "./workflow/stage-checks.js";

/** The resolve stage body and its checks over an in-memory store that holds only the script: no `slots` pin. */
function resolveChecks(script: ScriptV1) {
  const text = JSON.stringify(script);
  const bySha = new Map([[sha256(text), text]]);
  const store = { readText: (sha: string) => bySha.get(sha)!, putText: (put: string) => (bySha.set(sha256(put), put), sha256(put)) };
  const inputs = { script: sha256(text) };
  const outcome = runResolveStage({ artifacts: inputs, store, from: { runId: "r", stage: "resolve" }, remainingUsd: 1 }, resolveConfig());
  const { checks } = runStageChecks("resolve", { artifacts: { ...inputs, ...outcome.outputs }, store, l0Checks: [] });
  return (name: string) => checks.find((check) => check.name === name);
}

describe("the daily's stats block", () => {
  it("offers only kinds whose slots derive from a script's labels", () => {
    // Arrange
    const set = loadProfiles();
    const profile = profileFor(set, "daily-overview");

    // Act
    const stats = slotBlocks(profile, set.structures.get("goal-walk")!).find((block) => block.id === "stats");

    // Assert
    expect(stats?.beats).toEqual(["stat", "chart"]);
  });
});

describe("a synthetic daily script through resolve with no slots pin", () => {
  it("fills every beat and passes the emphasis-target gate", () => {
    // Arrange
    const script = dailyScript();

    // Act
    const check = resolveChecks(script);

    // Assert
    expect(script.chapters).toHaveLength(8);
    expect(script.beats).toHaveLength(13);
    expect(check("template-fill")).toMatchObject({ pass: true, detail: "13 beats filled, 0 by fallback" });
    expect(check("emphasis-target")).toMatchObject({ pass: true, detail: "0 of 22 emphasis cues fail" });
  });

  it("refuses the fill and names side-quests-1 when its list carries 7 labels", () => {
    // Arrange
    const seven = [...SIDE_QUEST_LABELS, "ops · Spare printer set up", "docs · Glossary trimmed", "test · Slow case split", "ops · Old branch parked"];

    // Act
    const check = resolveChecks(dailyScript({ "side-quests-1": seven }));

    // Assert
    expect(check("template-fill")).toMatchObject({ pass: false, detail: expect.stringContaining("refused 1 beat: side-quests-1 (list: beat list: rows Too big: expected array to have <=5 items") });
  });
});

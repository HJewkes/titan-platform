import { afterEach, describe, expect, it } from "vitest";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { editHarness, recordingSpawn } from "./edit-cli.test-helpers.js";
import { linkEditRun, readLedger } from "./edit-ledger.js";
import { fakeScriptModel, fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk, run on fakes end to end; no real script, run, render or note.
let fx: Fixture;
afterEach(() => fx.cleanup());

const { baseRun, editFile, cli } = editHarness(() => fx);
const figures = [{ id: "scan-rate", value: 4, label: "Scans a minute" }];
const LINKED_RUN = "run-linked-synthetic";

/** `edit apply --start` on a fresh base, then the launched run linking itself, as the detached run does on start. */
async function startedEdit() {
  fx = fixture();
  const base = await baseRun();
  const file = editFile(base, { h1: { slots: { figures } } });
  const { spawn, launched } = recordingSpawn();
  const { editId } = JSON.parse((await cli(["apply", file, "--start", "--json"], { spawn })).text);
  linkEditRun(fx.dataDir, editId, LINKED_RUN);
  return { file, editId, spawn, launched };
}

describe("explainer edit apply on an edit that already started a run", () => {
  it("refuses a second --start and launches nothing more", async () => {
    const { file, editId, spawn, launched } = await startedEdit();

    const { code, text } = await cli(["apply", file, "--start", "--json"], { spawn });

    expect(code).toBe(1);
    expect(text).toContain(`already started run ${LINKED_RUN}`);
    expect(launched).toHaveLength(1);
    expect(readLedger(fx.dataDir, editId)).toMatchObject({ status: "started", runId: LINKED_RUN });
  });

  it("refuses a plain apply, so the started row keeps its run and a later --start is still refused", async () => {
    const { file, editId, spawn, launched } = await startedEdit();

    const plain = await cli(["apply", file, "--json"], { spawn });
    const again = await cli(["apply", file, "--start", "--json"], { spawn });

    expect([plain.code, again.code]).toEqual([1, 1]);
    expect(readLedger(fx.dataDir, editId)).toMatchObject({ status: "started", runId: LINKED_RUN });
    expect(launched).toHaveLength(1);
  });
});

describe("explainer edit check through the template fill", () => {
  it("refuses an edit whose filled slots leave an emphasis cue with no element to land on", async () => {
    fx = fixture();
    // The base renders only if its cue lands on the figure its label derives, so the cue names the derived id.
    const cue = { action: "V6", target: "figures-1", atCue: "desk" };
    const visual = { assertion: "The desk refuses unknown parcels", job: "numbers", beat: "stat", labels: ["4 scans a minute"], cues: [cue] };
    const base = await baseRun({}, fakeScriptModel(choppy({ h1: { visual } }), { asWritten: true }));
    const renamed = [{ ...figures[0], id: "dock-rate" }];

    const kept = await cli(["check", editFile(base, { h1: { slots: { figures: [{ ...figures[0], id: "figures-1" }] } } })]);
    const { code, text } = await cli(["check", editFile(base, { h1: { slots: { figures: renamed } } }, "renamed.json")]);

    expect(kept.code).toBe(0);
    expect(code).toBe(1);
    expect(JSON.parse(text).problems).toEqual([
      'beats.h1.visual.slots.figures: drops element figures-1, which cue 0 (V6 at "desk") targets; keep its id or retarget the cue',
    ]);
  });

  it("refuses an edit that moves a fallback beat onto its chosen spec, where the cue's element does not exist", async () => {
    fx = fixture();
    // No number in the label, so the base fills stat's list fallback and the cue lands on a list row.
    const cue = { action: "V6", target: "rows-1", atCue: "desk" };
    const visual = { assertion: "The desk refuses unknown parcels", job: "numbers", beat: "stat", labels: ["Scans a minute"], cues: [cue] };
    const base = await baseRun({}, fakeScriptModel(choppy({ h1: { visual } }), { asWritten: true }));

    const { code, text } = await cli(["check", editFile(base, { h1: { slots: { figures } } })]);

    expect(code).toBe(1);
    expect(JSON.parse(text).problems).toEqual(["beats.h1.visual.cues.0: no-element: rows-1 names no element of beat spec stat"]);
  });
});

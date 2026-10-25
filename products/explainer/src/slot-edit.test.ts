import { describe, expect, it } from "vitest";
import { resolveScript, visual } from "./resolve-fixtures.test-helpers.js";
import { applyEdit, SlotEditSchema, type EditBase, type SlotEdit } from "./slot-edit.js";
import { sha256 } from "./workflow/artifacts.js";

// Synthetic: an invented parcel desk with three beats; nothing here quotes a real script, run or video.
const cue = { action: "V6", target: "old-lane", atCue: "ledger" };
const rows = [{ id: "old-lane", left: "One queue", right: "Two queues" }];

const script = JSON.parse(JSON.stringify(resolveScript([
  ["b1", "WHAT", { visual: visual({ beat: "list", labels: ["two lanes"] }) }],
  ["b2", "WHAT", { visual: visual({ beat: "compare", labels: ["old", "new"], cues: [cue] }) }],
  ["b3", "HOW", { visual: visual({ beat: "chart", layer: "custom", labels: ["4 a day"] }) }],
]))) as Record<string, unknown>;

const base: EditBase = {
  runId: "run-base",
  scriptSha: sha256(JSON.stringify(script)),
  script,
  layers: new Map([["b1", "template"], ["b2", "template"], ["b3", "custom"]]),
  generated: { b2: { leftTitle: "Before", rightTitle: "After", rows } },
};

function edit(beats: SlotEdit["beats"], over: Partial<SlotEdit["base"]> = {}): SlotEdit {
  return SlotEditSchema.parse({
    schema: "explainer.slot-edit/v1",
    base: { runId: "run-base", scriptSha: base.scriptSha, mp4Sha: "e".repeat(64), ...over },
    beats,
    createdAt: "2026-10-24T00:00:00Z",
  });
}

type Beat = { id: string; visual: Record<string, unknown> };
const beatsOf = (value: Record<string, unknown>): Beat[] => value.beats as Beat[];
const withoutOverrides = (value: Record<string, unknown>) =>
  ({ ...value, beats: beatsOf(value).map((beat) => ({ ...beat, visual: { ...beat.visual, slots: undefined, tune: undefined } })) });

describe("applyEdit", () => {
  it("writes an accepted edit into visual.slots and visual.tune only, and diffs each field against what the render saw", () => {
    const next = [{ id: "old-lane", left: "One shelf", right: "Two shelves" }];

    const result = applyEdit(base, edit({ b2: { slots: { rows: next }, tune: { stagger: 0.2 } } }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(beatsOf(result.script)[1]!.visual).toMatchObject({ slots: { rows: next }, tune: { stagger: 0.2 } });
    expect(withoutOverrides(result.script)).toEqual(withoutOverrides(script));
    expect(result.diff).toEqual([
      { beat: "b2", path: "visual.slots.rows", before: rows, after: next },
      { beat: "b2", path: "visual.tune.stagger", before: undefined, after: 0.2 },
    ]);
  });

  it("refuses an edit drafted on another script than the base run's", () => {
    const result = applyEdit(base, edit({ b1: { slots: { title: "Lanes" } } }, { scriptSha: "a".repeat(64) }));

    expect(result).toEqual({ ok: false, problems: [expect.stringMatching(/^base: the edit was drafted on script aaaaaaaaaaaa, but run run-base's script is/)] });
  });

  it("refuses a beat the script lacks and a custom-layer beat, naming each", () => {
    const result = applyEdit(base, edit({ b9: { slots: { title: "Lanes" } }, b3: { slots: { kind: "line" } } }));

    expect(result).toEqual({
      ok: false,
      problems: ["beats.b9: the base script has no beat b9", "beats.b3: its layer is custom; v1 edits change slots and tune on template beats only"],
    });
  });

  it("refuses renaming or deleting an element a cue targets, naming the cue", () => {
    const renamed = [{ id: "new-lane", left: "One queue", right: "Two queues" }];

    const result = applyEdit(base, edit({ b2: { slots: { rows: renamed } } }));

    expect(result).toEqual({
      ok: false,
      problems: ['beats.b2.visual.slots.rows: drops element old-lane, which cue 0 (V6 at "ledger") targets; keep its id or retarget the cue'],
    });
  });

  it("refuses an edit to anything outside slots and tune, naming the field", () => {
    const parsed = SlotEditSchema.safeParse({ ...edit({}), beats: { b2: { spoken: "A new line.", framing: "wide" } } });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ path: ["beats", "b2"], keys: ["spoken", "framing"] })]);
  });

  it("a null drops an override so the generated value stands, and an edit that changes nothing is refused", () => {
    const overridden = { ...base, script: { ...script, beats: beatsOf(script).map((b) => (b.id === "b1" ? { ...b, visual: { ...b.visual, slots: { title: "Lanes" } } } : b)) } };
    const shaOf = { scriptSha: sha256(JSON.stringify(overridden.script)) };

    const cleared = applyEdit({ ...overridden, ...shaOf }, edit({ b1: { slots: { title: null } } }, shaOf));
    const unchanged = applyEdit(base, edit({ b2: { slots: { rows } } }));

    expect(cleared.ok && beatsOf(cleared.script)[0]!.visual).not.toHaveProperty("slots");
    expect(cleared.ok && cleared.diff).toEqual([{ beat: "b1", path: "visual.slots.title", before: "Lanes", after: undefined }]);
    expect(unchanged).toEqual({ ok: false, problems: ["beats: the edit changes nothing"] });
  });
});

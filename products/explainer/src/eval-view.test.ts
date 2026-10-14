import { describe, expect, it } from "vitest";
import { deriveEvalView, toMapBeats } from "./eval-view.js";
import { lintMapBeats } from "./map-lints.js";
import { MapLayoutSchema } from "./map-state.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const stations = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"];

const stationsBeat = {
  why: { need: "a reader trusts a scan", actor: "reader", consequence: "a bad label never ships", fact_ids: ["F1"] },
  fact_ids: ["F1", "F3"],
  visual: {
    assertion: "One server sits between every scanner and the ledger",
    job: "map",
    map_state: {
      level: "containers",
      visible: stations,
      edges: [
        { id: "S1>S2:cli", atCue: "scan" },
        { id: "S3>S5:sse", atCue: "ledger" },
      ],
      focus: { ids: ["S3"], atCue: "server" },
    },
    chips: [{ kind: "verified", text: "traced by reading", fact_id: "F3" }],
    labels: ["Desk server"],
  },
};

const offMapBeat = {
  id: "c2-2-count",
  chapter: "ch2",
  function: "WHAT",
  mode: "explain",
  plannedS: 6,
  spoken: "The ledger holds nine thousand scans.",
  fact_ids: [],
  visual: { assertion: "The ledger holds nine thousand scans", job: "numbers", cues: [{ action: "V9", target: "count", atCue: "nine" }] },
};

const reentryBeat = {
  id: "c2-3-back",
  chapter: "ch2",
  function: "HOW",
  mode: "explain",
  plannedS: 8,
  spoken: "Back at the map, the worker drains the queue.",
  fact_ids: [],
  visual: { assertion: "The worker drains the queue", job: "map", map_state: { level: "containers", reveal: [{ id: "S6", atCue: "worker" }] } },
};

describe("deriveEvalView", () => {
  it("derives the eval contract's station view from map_state", () => {
    const script = ScriptSchema.parse(scriptWith(stationsBeat));

    const [view] = deriveEvalView(script);

    expect(view).toEqual({
      id: "c2-1-stations",
      function: "WHAT",
      assertion: "One server sits between every scanner and the ledger",
      why: stationsBeat.why,
      spoken: "Every scan passes one desk server before it reaches the ledger.",
      visual: {
        map_id: "pd-l1",
        mode: "map",
        you_are_here: "S3",
        nodes_shown: stations,
        edges_shown: ["S1>S2:cli", "S3>S5:sse"],
        state_changes: [
          { cue: "scan", op: "edge", target: "S1>S2:cli" },
          { cue: "server", op: "focus", target: "S3" },
          { cue: "ledger", op: "edge", target: "S3>S5:sse" },
        ],
        labels: ["Desk server"],
        chips: ["traced by reading"],
      },
      facts: ["F1", "F3"],
    });
  });

  it("shows an off-map beat with no map and keeps its cued actions", () => {
    const base = scriptWith(stationsBeat);
    const script = ScriptSchema.parse({ ...base, beats: [...base.beats, offMapBeat] });

    const view = deriveEvalView(script)[1]?.visual;

    expect(view).toMatchObject({ map_id: null, mode: "none", you_are_here: null, nodes_shown: [] });
    expect(view?.state_changes).toEqual([{ cue: "nine", op: "V9", target: "count" }]);
  });

  it("resumes the last map state when a beat re-enters the map", () => {
    const base = scriptWith({ visual: { assertion: "Three parts", job: "map", map_state: { level: "containers", reveal: [{ id: "S1", atCue: "scan" }], focus: { ids: ["S1"], atCue: "scan" } } } });
    const script = ScriptSchema.parse({ ...base, beats: [...base.beats, offMapBeat, reentryBeat] });

    const view = deriveEvalView(script)[2]?.visual;

    expect(view).toMatchObject({ mode: "map", you_are_here: "S1", nodes_shown: ["S1", "S6"] });
  });

  it("resolves visible level to the layout's nodes", () => {
    const script = ScriptSchema.parse(scriptWith({ visual: { assertion: "All parts", job: "map", map_state: { level: "containers", visible: "level" } } }));
    const layout = MapLayoutSchema.parse({ nodes: [{ id: "S2" }, { id: "S1" }], edges: [] });

    expect(deriveEvalView(script, layout)[0]?.visual.nodes_shown).toEqual(["S1", "S2"]);
  });
});

describe("toMapBeats", () => {
  it("lets the map lints run on a script, with an unset layout source counted as hand", () => {
    const base = scriptWith(stationsBeat);
    const script = ScriptSchema.parse({ ...base, video: { ...base.video, map: undefined } });
    const layout = MapLayoutSchema.parse({ nodes: stations.map((id) => ({ id })), edges: [] });

    const rules = lintMapBeats(toMapBeats(script), layout).map((l) => l.rule);

    expect(rules).toContain("hand-framing");
    expect(rules).toContain("unknown-id");
  });
});

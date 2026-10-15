// A verbatim copy of titan-design's `mapTimelineFixture` (packages/ui network-graph/map/fixtures.ts),
// synthetic data for a made-up notes app. Re-copy it when that file changes; diagram-map.test.ts then
// fails on any field the TP mirror does not know.
export const tdMapTimelineFixture: unknown = {
  layoutSha: "sha256:synthetic-fixture",
  spans: [
    { startS: 0, endS: 6 },
    { startS: 9, endS: 14 },
  ],
  keyframes: [
    { atS: 0, durS: 0, op: "level", level: 1 },
    { atS: 0.5, durS: 0.4, op: "reveal", ids: ["pkg/web"] },
    { atS: 1.5, durS: 0.4, op: "reveal", ids: ["pkg/api"] },
    { atS: 1.5, durS: 0.6, op: "edge", ids: ["e:web->api"] },
    { atS: 2.5, durS: 0.4, op: "reveal", ids: ["pkg/store"] },
    { atS: 2.5, durS: 0.6, op: "edge", ids: ["e:api->store"] },
    { atS: 3, durS: 0.25, op: "minimap", on: true },
    { atS: 4, durS: 0.4, op: "focus", ids: ["pkg/api", "pkg/web"] },
    { atS: 5.8, durS: 0.4, op: "lit", ids: ["pkg/api"] },
    { atS: 9.2, durS: 0, op: "level", level: 3 },
    { atS: 9.2, durS: 0.4, op: "reveal", ids: ["pkg/api/routes/notes.ts"] },
    { atS: 9.5, durS: 0.4, op: "focus", ids: ["pkg/api/routes/notes.ts"] },
    { atS: 10, durS: 0.25, op: "card-in", ids: ["card:notes.ts"] },
    { atS: 12.5, durS: 0.25, op: "card-out", ids: ["card:notes.ts"] },
  ],
};

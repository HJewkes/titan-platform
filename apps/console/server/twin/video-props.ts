// Synthetic `videos.props` and `videos.edits` answers for the twin's theater player: one compare beat and one list beat,
// with the JSON Schema shapes zod emits for those slots, and two saved edits over them. Every value is invented.
import type { ServedCommands } from "../../src/data/rpc.js";

const ID = { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" };
const LINE = { type: "string", minLength: 1, maxLength: 160 };
const LABEL = { type: "string", minLength: 1, maxLength: 48 };
const strict = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

const COMPARE = strict({ leftTitle: LABEL, rightTitle: LABEL, rows: { type: "array", minItems: 1, maxItems: 4, items: strict({ id: ID, alias: ID, left: LINE, right: LINE }, ["id", "left", "right"]) } }, ["leftTitle", "rightTitle", "rows"]);
const LIST = strict({ title: LABEL, rows: { type: "array", minItems: 1, maxItems: 5, items: strict({ id: ID, text: LINE, mark: { type: "string", enum: ["tick", "cross", "risk", "open", "dot"] } }, ["id", "text", "mark"]) } }, ["rows"]);

export const TWIN_VIDEO_PROPS: ServedCommands["videos.props"]["result"] = {
  mp4Sha: "ab".repeat(32),
  props: {
    runId: "run-twin-0001",
    scriptSha: "cd".repeat(32),
    saveBack: { enabled: true },
    beats: [
      {
        id: "b-compare", chapter: "c1", spec: "compare", slots: "compare", schema: COMPARE, overridden: [], locked: ["latency"], startS: 0, endS: 6.4, stillS: 6.1,
        value: { leftTitle: "Polling", rightTitle: "Push", rows: [{ id: "latency", left: "Seconds behind the source", right: "Near instant" }, { id: "cost", left: "Steady load all day", right: "Load only on change" }] },
      },
      {
        id: "b-list", chapter: "c1", spec: "list", slots: "list", schema: LIST, overridden: ["title"], locked: ["tests-pass"], startS: 6.4, endS: 12.8, stillS: 12.5,
        value: { title: "Before you ship", rows: [{ id: "tests-pass", text: "Tests pass on a clean checkout", mark: "tick" }, { id: "docs-updated", text: "Docs name the new flag", mark: "open" }] },
      },
    ],
  },
  gaps: [],
};

const BASE = { runId: "run-twin-0001", scriptSha: "cd".repeat(32), mp4Sha: "ab".repeat(32) };

export const TWIN_VIDEO_EDITS: ServedCommands["videos.edits"]["result"] = {
  edits: [
    {
      editId: "edit-0000000000000a01", base: BASE, beats: { "b-list": { slots: { title: "Before you merge" } } }, fromNote: "0123456789abcdef",
      createdAt: "2031-03-05T09:00:00.000Z", status: "started", runId: "run-twin-0002", runStatus: "completed",
    },
    {
      editId: "edit-0000000000000a02", base: BASE, beats: { "b-compare": { slots: { leftTitle: "Polling loop" } }, "b-list": { slots: { title: "Ready to ship" } } },
      createdAt: "2031-03-05T10:00:00.000Z", status: "started", runStatus: "starting",
    },
  ],
  gaps: [],
};

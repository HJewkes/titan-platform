// A synthetic `videos.props` answer for the twin's theater player: one compare beat and one list beat, with the JSON
// Schema shapes zod emits for those slots. Every value is invented.
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
    saveBack: { enabled: false, reason: "renders ignore edits until TP-2992 S3" },
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

import { describe, expect, it } from "vitest";
import { fromScriptV1 } from "./pace-items.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { sha256 } from "./workflow/artifacts.js";
import { runStageChecks, STAGE_CHECKS, type CheckInput } from "./workflow/stage-checks.js";

const paceGate = STAGE_CHECKS.script.filter((check) => check.name === "pace");

function draftInput(draft: unknown): CheckInput {
  const text = JSON.stringify(draft);
  return { artifacts: { draft: sha256(text) }, store: { readText: () => text }, l0Checks: [] };
}

const paceVerdict = (draft: unknown) => runStageChecks("script", draftInput(draft), paceGate).checks[0];

// An invented recipe beat: the steps run, then their memo markers light up.
const recipeDraft = () =>
  scriptWith({
    visual: {
      assertion: "Each step leaves a marker",
      job: "map",
      cues: [
        { action: "V11", target: "run:plan", atCue: "server" },
        { action: "V11", target: "step-markers:plan,claim", atCue: "ledger" },
      ],
    },
  });

// An invented beat that names a beat spec, so its cue targets are the spec's element ids, not kind:label.
const emphasisDraft = () =>
  scriptWith({
    visual: {
      assertion: "One server sits between every scanner and the ledger",
      job: "code-proof",
      beat: "code-walk",
      cues: [
        { action: "V9", target: "close", atCue: "server", untilCue: "ledger" },
        { action: "V9", target: "open", atCue: "scan" },
      ],
    },
  });

describe("the script-stage pace gate on cue kinds outside the original table", () => {
  // Mutation: dropping step-markers from CUE_KIND_ROLES makes the gate fail with "could not run: unknown cue kind".
  it("reaches a verdict on a draft with a step-markers cue and counts it as an attribute", () => {
    const verdict = paceVerdict(recipeDraft());

    expect(verdict?.detail).not.toMatch(/could not run/);
    expect(fromScriptV1(ScriptSchema.parse(recipeDraft()))[0]?.items.map((i) => [i.kind, i.role])).toEqual([
      ["run", "action"],
      ["step-markers", "attribute"],
    ]);
  });

  // Mutation: reading emphasis cue targets as kind:label throws "unknown cue kind \"close\"" and the gate cannot run.
  it("reaches a verdict on a beat-spec beat whose emphasis cues name element ids", () => {
    const verdict = paceVerdict(emphasisDraft());

    expect(verdict?.detail).not.toMatch(/could not run/);
    expect(fromScriptV1(ScriptSchema.parse(emphasisDraft()))[0]?.items.map((i) => [i.label, i.role])).toEqual([
      ["close", "attribute"],
      ["open", "attribute"],
    ]);
  });
});

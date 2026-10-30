import type { AgentRunnerOptions, StepRunInput, StepRunOutcome } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { dailyWith } from "../daily-script.test-helpers.js";
import type { L0Check } from "../eval-l0.js";
import { cueGapCheck } from "../lint-cadence.js";
import { ScriptSchema, type ScriptV1 } from "../script-schema.js";
import { splitKeeps } from "../repair-hints-screen.js";
import { splitCuelessBeats } from "../script-split.js";
import { MAX_REPAIR_ROUNDS, runScriptStage, type ModelStageInput } from "./model-stages.js";
import { SPINE } from "./run-fakes.test-helpers.js";

// A synthetic parcel-floor reflection of three sentences: too long for one cue-less card, and each sentence fits one.
const THREE_SENTENCES =
  "You might blame the review queue, but no gate on the floor waited on the lead. The dock scanner is what slows us, at a median of eighteen minutes on the north line. The router lane should test its matcher on every dock, and the cache lane should warm its store.";
const FACTS = "# Facts\n\n| Id | Claim |\n|---|---|\n| F1 | The dock scanner is the slowest stage. |\n";
const REPAIRED_ID = "parcel-floor-day-linked";
const SPLIT_HINT = "- split: reflection-2 was split by code into reflection-2, reflection-2b, reflection-2c: give each boundary a spoken link";

const seed = (): ScriptV1 => dailyWith("reflection-2", { plannedS: 20, heldS: 4, spoken: THREE_SENTENCES });
const splitOfSeed = (): ScriptV1 => splitCuelessBeats(seed()).script;

/** Stands in for Q-F1 on the split's new boundaries: each unlinked piece fails until the model links it. */
const unlinkedPieces = (rows = 1): L0Check => ({ script }) => {
  const pieces = script.beats.some((beat) => beat.id === "reflection-2b") && script.id !== REPAIRED_ID;
  return Array.from({ length: rows }, (_, i) => ({ check_id: `fake-link-${i}`, mode: "tagged" as const, severity: "error" as const, value: 0, threshold: 1, pass: !pieces, detail_beats: [] }));
};

function stageInput(): ModelStageInput & { read: (sha: string) => string } {
  const texts = new Map<string, string>([["spine-sha", SPINE], ["facts-sha", FACTS], ["seed-sha", JSON.stringify(seed())]]);
  const store = {
    readText: (sha: string) => texts.get(sha)!,
    putText: (text: string) => {
      const sha = `sha-${texts.size}`;
      texts.set(sha, text);
      return sha;
    },
  };
  return { artifacts: { spine: "spine-sha", facts: "facts-sha", "seed-draft": "seed-sha" }, store, from: { runId: "r1", stage: "script" }, remainingUsd: 5, read: store.readText };
}

function fakeModel(reply: ScriptV1) {
  const prompts: string[] = [];
  const runnerFor = (_options: AgentRunnerOptions) => ({
    run: async (input: StepRunInput): Promise<StepRunOutcome> => {
      prompts.push(input.prompt);
      return { ok: true, output: JSON.stringify(reply), usage: { costUsd: 0.01, inputTokens: 100, outputTokens: 50 } };
    },
  });
  return { prompts, runnerFor };
}

async function runSeeded(reply: ScriptV1, checks: readonly L0Check[] = [cueGapCheck, unlinkedPieces()]) {
  const input = stageInput();
  const model = fakeModel(reply);
  const outcome = await runScriptStage(input, { model: "fake", profile: "daily-overview", runnerFor: model.runnerFor, l0Checks: checks, g2p: { tokens: () => [] } });
  const draft = ScriptSchema.parse(JSON.parse(input.read(outcome.outputs.draft!)));
  return { outcome, draft, prompts: model.prompts, read: input.read };
}

const ids = (script: ScriptV1): string[] => script.beats.map((beat) => beat.id);

describe("the split as the repair's starting script", () => {
  it("an equal-count split becomes the repair's starting script, not its answer", async () => {
    const unrepaired = splitOfSeed();

    const { prompts, draft } = await runSeeded(unrepaired);

    expect(prompts[0]).toContain('"id":"reflection-2b"');
    expect(prompts[0]).toContain(SPLIT_HINT);
    expect(ids(draft)).toEqual(ids(seed()));
  });

  it("a repaired split is kept only when it beats the seed", async () => {
    const linked = { ...splitOfSeed(), id: REPAIRED_ID };

    const { draft, prompts } = await runSeeded(linked);

    expect(prompts).toHaveLength(1);
    expect(ids(draft)).toContain("reflection-2c");
    expect(draft.beats.find((beat) => beat.id === "reflection-2c")?.heldS).toBe(4);
  });

  it("a split that fails more rows than the seed never starts the repair", async () => {
    const { prompts } = await runSeeded(seed(), [cueGapCheck, unlinkedPieces(2)]);

    expect(prompts[0]).not.toContain('"id":"reflection-2b"');
    expect(prompts[0]).not.toContain("- split:");
  });

  it("a failed script stage stores its repair candidates and the hint it sent", async () => {
    const unrepaired = splitOfSeed();

    const { outcome, read } = await runSeeded(unrepaired);

    const rounds = Array.from({ length: MAX_REPAIR_ROUNDS }, (_, i) => `candidate-repair-${i + 1}`);
    expect(Object.keys(outcome.outputs)).toEqual(expect.arrayContaining(["candidate-split", ...rounds]));
    expect(ids(ScriptSchema.parse(JSON.parse(read(outcome.outputs["candidate-split"]!))))).toContain("reflection-2b");
    expect(outcome.notes).toContain(`repair candidates: ${["candidate-split", ...rounds].map((name) => `${name} ${outcome.outputs[name]}`).join(", ")}`);
    expect(outcome.notes?.find((note) => note.startsWith("repair-1 hint:"))).toContain(SPLIT_HINT);
  });

  it("the split hint asks every reflection piece to cite its slow fact", async () => {
    const { prompts } = await runSeeded(splitOfSeed());

    expect(prompts[0]).toContain("cite the slow/ fact it answers in every piece");
    expect(prompts[0]).toContain("keep each piece's fact_ids");
  });

  it("the split hint forbids a chip number the piece does not speak", async () => {
    const { prompts } = await runSeeded(splitOfSeed());

    expect(prompts[0]).toContain("no number on a chip or label that the piece does not speak");
  });

  it("the split hint and the cueless move share their keep clauses", async () => {
    const { prompts } = await runSeeded(splitOfSeed());

    expect(prompts[0]).toContain(splitKeeps(seed().beats.find((beat) => beat.id === "reflection-2")!));
  });

  it("the split hint asks for a chip in other words than the spoken line", async () => {
    const { prompts } = await runSeeded(splitOfSeed());

    expect(prompts[0]).toContain("a claim and chip in other words than the spoken line, drawn from the piece's own facts");
    expect(prompts[0]).toContain("no claim, chip or label repeating 5 or more spoken words in a row");
  });
});

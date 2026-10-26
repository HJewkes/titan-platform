import { describe, expect, it } from "vitest";
import type { L0Check } from "../eval-l0.js";
import { DEFAULT_JUDGE } from "./host.js";
import { runEvalStage, StageFailure } from "./model-stages.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import type { ScriptV1 } from "../script-schema.js";
import { voiceCheck } from "../lint-voice.js";
import { claimsCheck } from "../lint-claims.js";
import { spellScript } from "../rewrite-pass.js";
import { sha256 } from "./artifacts.js";
import { l0Check, SPINE } from "./run-fakes.test-helpers.js";
import { failedGates, runStageChecks, STAGE_CHECKS, type CheckInput } from "./stage-checks.js";

/** An in-memory store over named texts: the artifact map points each name at its text's sha. */
function input(texts: Record<string, string>, l0Checks: readonly L0Check[] = [l0Check(true)]): CheckInput {
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const artifacts = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  return { artifacts, store: { readText: (sha) => bySha.get(sha)! }, l0Checks };
}

const json = (value: unknown): string => JSON.stringify(value);
const verdict = (run: ReturnType<typeof runStageChecks>, name: string) => run.checks.find((check) => check.name === name);
const warning = (pass: boolean): L0Check => () => [{ check_id: "fake-warn", mode: "tagged", severity: "warning", value: pass ? 0 : 1, threshold: 0, pass, detail_beats: [] }];

/** h1 shows a V6 card on "courier", a word h1 speaks. */
const cued = (): ScriptV1 => choppy({ h1: { visual: { assertion: "The desk refuses unknown parcels", job: "numbers", cues: [{ action: "V6", target: "card", atCue: "courier" }] } } });

/** SPINE with a chapter order whose ch1 leads on verdict-card, a beat spec with an emphasis target list. */
const LEAD_SPINE = `${SPINE}
## 8. Chapter order
| Chapter | Question | Rows | Beat |
|---|---|---|---|
| ch1 | Why does the desk refuse a parcel? | §3.1 | verdict-card |
`;

type Cue = ScriptV1["beats"][number]["visual"]["cues"][number];
/** h1 names verdict-card, with the given cues. */
const verdictLead = (cues: Cue[]): ScriptV1 =>
  choppy({ h1: { visual: { assertion: "The desk refuses unknown parcels", job: "numbers", beat: "verdict-card", cues } } });

function words(script: ScriptV1, drop?: string): string {
  const beats = script.beats.map((beat) => {
    const spoken = beat.spoken.split(/\s+/).filter((word) => word !== drop);
    return { id: beat.id, durationS: spoken.length + 1, words: spoken.map((word, i) => ({ word, start: i, end: i + 1 })) };
  });
  return json({ beats });
}

describe("script stage checks", () => {
  it("gates on an error-severity L0 row and only reports a failing warning row", () => {
    const run = runStageChecks("script", input({ draft: json(choppy()), spine: SPINE }, [l0Check(false), warning(false)]));

    expect(verdict(run, "l0")).toMatchObject({ gate: true, pass: false, detail: expect.stringContaining("fake-l0") });
    expect(verdict(run, "l0-warnings")).toMatchObject({ gate: false, pass: false, detail: expect.stringContaining("fake-warn (warning)") });
    expect(failedGates(run.checks).map((check) => check.name)).toEqual(["l0"]);
  });

  it("passes l0 when only a warning row fails", () => {
    const run = runStageChecks("script", input({ draft: json(choppy()), spine: SPINE }, [l0Check(true), warning(false)]));

    expect(verdict(run, "l0")).toMatchObject({ pass: true });
  });

  it("gates on an error-severity pace row: a beat bringing five new terms", () => {
    const crowded = choppy({ h1: { new_terms: ["scan", "label", "dock", "ledger row", "courier app"] } });

    const run = runStageChecks("script", input({ draft: json(crowded), spine: SPINE }));

    expect(verdict(run, "pace")).toMatchObject({ gate: true, pass: false, detail: expect.stringContaining("Q-E7") });
  });

  it("passes pace on the plain draft", () => {
    expect(verdict(runStageChecks("script", input({ draft: json(choppy()), spine: SPINE })), "pace")).toMatchObject({ pass: true });
  });

  // Mutation: skipping a beat's own spec check lets a verdict-card with no cue through.
  it("gates on a beat whose beat spec has emphasis targets and no cue", () => {
    const run = runStageChecks("script", input({ draft: json(verdictLead([])), spine: LEAD_SPINE }));

    expect(verdict(run, "cues-present")).toMatchObject({ gate: true, pass: false, detail: "uncued: h1 (verdict-card) has no cue for reasons" });
  });

  // Mutation: skipping the spine's lead beats passes a draft that never places verdict-card, at 0 cues.
  it("gates on a chapter whose lead beat spec is on none of its beats, so a cue-less draft is no vacuous pass", () => {
    const run = runStageChecks("script", input({ draft: json(choppy()), spine: LEAD_SPINE }));

    expect(verdict(run, "cues-present")).toMatchObject({ gate: true, pass: false, detail: "uncued: ch1's lead beat verdict-card is on none of its beats" });
  });

  // Mutation: dropping the facts from the script stage's L0 leaves Q-E20 a passing "did not run" warning.
  it("fails a daily draft whose count the gathered facts do not back, on Q-E20", () => {
    const facts = "# Facts: daily 2031-01-02\n\n| Id | Claim |\n|---|---|\n| task/QA-901/opened | task opened · demo · Add a widget |\n";
    const draft = choppy({ h2: { spoken: "Four tasks opened today at the desk.", fact_ids: ["task/QA-901/opened"] } });

    const run = runStageChecks("script", input({ draft: json(draft), spine: SPINE, facts }, [claimsCheck]));

    expect(verdict(run, "l0")).toMatchObject({ gate: true, pass: false, detail: expect.stringContaining("Q-E20") });
  });

  // Mutation: testing misaki's rating instead of the phonemes, or dropping the lexicon, changes these verdicts.
  it("gates on a spoken word the voice has no phonemes for, naming the word and its beat", () => {
    const draft = choppy({ h2: { spoken: "The desk held 12 parcels through zqxjkv today." } });

    const run = runStageChecks("script", input({ draft: json(draft), spine: SPINE }));

    expect(verdict(run, "unknown-words")).toMatchObject({ gate: true, pass: false, detail: "no phonemes for: zqxjkv (h2)" });
  });

  it("passes unknown-words on a word only the doctrine lexicon voices, and on spelled numbers", () => {
    const draft = choppy({ h2: { spoken: "The desk encodes 12 parcels with ffmpeg today." } });

    const run = runStageChecks("script", input({ draft: json(draft), spine: SPINE }));

    expect(verdict(run, "unknown-words")).toMatchObject({ pass: true });
  });

  it("passes cues-present when the lead beat names its spec and cues a target", () => {
    const draft = verdictLead([{ action: "V6", target: "reasons-1", atCue: "courier" }]);

    const run = runStageChecks("script", input({ draft: json(draft), spine: LEAD_SPINE }));

    expect(verdict(run, "cues-present")).toMatchObject({ pass: true });
  });
});

describe("rewrite stage checks", () => {
  const draft = choppy();
  const rewritten = { ...draft, id: `${draft.id}-rw` };
  const failsOnRewrite: L0Check = (l0) => l0Check(!l0.script.id.endsWith("-rw"))(l0);
  const report = (pass: boolean) => json({ after: [{ check_id: "triads", value: 3, threshold: 1, pass }] });

  it("gates on an error row the rewrite turned red", () => {
    const run = runStageChecks("rewrite", input({ draft: json(draft), script: json(rewritten), "rewrite-report": report(true) }, [failsOnRewrite]));

    expect(verdict(run, "no-new-l0-error")).toMatchObject({ gate: true, pass: false, detail: "new failing error rows: fake-l0" });
  });

  it("compares a reverted rewrite with the spelled draft, so spelling alone adds no error row", () => {
    const ids = "The desk closed PR 2324 after TP-4103 and then it also opened PR 2325 beside TP-4104 for the courier.";
    const plain = choppy();
    const idDraft = { ...plain, beats: plain.beats.map((beat) => (beat.id === "h1" ? { ...beat, spoken: ids } : beat)) };
    const reverted = spellScript({ ...idDraft, id: `${idDraft.id}-rw` });
    const run = runStageChecks("rewrite", input({ draft: json(idDraft), script: json(reverted), "rewrite-report": report(true) }, [voiceCheck]));

    expect(verdict(run, "no-new-l0-error")).toMatchObject({ pass: true });
  });

  it("passes when the error row was already red on the draft", () => {
    const run = runStageChecks("rewrite", input({ draft: json(draft), script: json(rewritten), "rewrite-report": report(true) }, [l0Check(false)]));

    expect(verdict(run, "no-new-l0-error")).toMatchObject({ pass: true });
  });

  it("reports a red target row without gating", () => {
    const run = runStageChecks("rewrite", input({ draft: json(draft), script: json(rewritten), "rewrite-report": report(false) }));

    expect(verdict(run, "rewrite-rows")).toMatchObject({ gate: false, pass: false, detail: "1 of 1 target rows red: triads" });
    expect(failedGates(run.checks)).toEqual([]);
  });
});

describe("tts stage checks", () => {
  it("passes when every cue lands on a voiced word", () => {
    const script = cued();

    const run = runStageChecks("tts", input({ script: json(script), words: words(script) }));

    expect(verdict(run, "cue-resolution")).toMatchObject({ gate: true, pass: true, detail: "1 of 1 cues resolve" });
  });

  it("gates on a cue whose word the voice never spoke", () => {
    const script = cued();

    const run = runStageChecks("tts", input({ script: json(script), words: words(script, "courier") }));

    expect(verdict(run, "cue-resolution")).toMatchObject({ gate: true, pass: false, detail: "0 of 1 cues resolve; unresolved: h1:courier" });
  });

  it("passes with a beat resolve cut, whose cue tts never voiced", () => {
    const cue = (atCue: string) => ({ visual: { assertion: "The desk refuses unknown parcels", job: "numbers", cues: [{ action: "V6", target: "card", atCue }] } });
    const script = choppy({ h1: cue("courier"), h3: cue("scan") });
    const voiced = { ...script, beats: script.beats.filter((beat) => beat.id !== "h1") };
    const resolved = { schema: "explainer.resolved/v1", profile: script.profile, beats: [], budgets: [], cut: [{ id: "h1", chapter: "ch1", code: "E-SIM-MISS", detail: "synthetic miss" }] };

    const run = runStageChecks("tts", input({ script: json(script), words: words(voiced), resolved: json(resolved) }));

    expect(verdict(run, "cue-resolution")).toMatchObject({ gate: true, pass: true, detail: "1 of 1 cues resolve" });
  });

  // Mutation: passing at 0 cues lets a script whose beat specs want emphasis render with no cue at all.
  it("gates on a script of no cues when a beat names a beat spec with emphasis targets", () => {
    const script = verdictLead([]);

    const run = runStageChecks("tts", input({ script: json(script), words: words(script) }));

    expect(verdict(run, "cue-resolution")).toMatchObject({ gate: true, pass: false, detail: "0 cues, but 1 beats name a beat spec with emphasis targets" });
  });
});

describe("running a stage's checks", () => {
  it("skips a check whose artifact the stage did not produce, with a note instead of a verdict", () => {
    const run = runStageChecks("tts", input({ script: json(cued()) }));

    expect(run.checks).toEqual([]);
    expect(run.notes).toEqual(["check cue-resolution skipped: no words artifact"]);
  });

  it("fails a check that cannot read its artifact, naming why", () => {
    const run = runStageChecks("tts", input({ script: json(cued()), words: "not json" }));

    expect(verdict(run, "cue-resolution")).toMatchObject({ pass: false, detail: expect.stringMatching(/^could not run: /) });
  });

  it("declares every check either a gate or reported", () => {
    const roles = Object.fromEntries(Object.entries(STAGE_CHECKS).map(([stage, checks]) => [stage, checks.map((c) => `${c.name}:${c.gate ? "gate" : "reported"}`)]));

    expect(roles).toEqual({
      gather: [],
      audition: [],
      script: ["l0:gate", "l0-warnings:reported", "pace:gate", "cues-present:gate", "unknown-words:gate", "word-budget:gate", "runtime:gate", "beat-length:gate", "label-conventions:reported"],
      rewrite: ["no-new-l0-error:gate", "rewrite-rows:reported"],
      eval: [], resolve: [
        "variety-top-component:reported", "variety-component-run:reported", "variety-template-share:reported", "variety-framing-run:reported",
        "variety-min-framings:reported", "variety-cast-in-motion:reported", "emphasis-target:gate", "word-budget:gate", "slot-overrides:gate", "template-fill:gate",
        "sim-check:reported", "sim-cut-orphan:gate",
      ], tts: ["cue-resolution:gate"], render: [], qa: ["held-errors:gate", "mp4-duration:gate"], sheets: [],
    });
  });
});

describe("eval stage gates", () => {
  it("fails with its gate verdicts attached, before the rubric spends", async () => {
    const { artifacts, store } = input({ script: json(choppy()), spine: SPINE });
    const stage = { artifacts, store: { ...store, putText: () => "unused" }, from: { runId: "r", stage: "eval" }, remainingUsd: 1 };
    let judged = 0;

    const run = runEvalStage(stage, { judge: DEFAULT_JUDGE, harnessFor: () => { judged++; throw new Error("no judge"); } }, [l0Check(false)]);

    await expect(run).rejects.toBeInstanceOf(StageFailure);
    await expect(run).rejects.toMatchObject({ checks: [{ name: "l0", gate: true, pass: false }, { name: "pace", gate: true, pass: true }] });
    expect(judged).toBe(0);
  });
});

/** A synthetic resolved artifact: one beat per component name, all in the full framing on the template layer unless varied. */
const resolvedArtifact = (components: readonly string[], varied: boolean, profile = "repo-tour"): string =>
  json({
    schema: "explainer.resolved/v1",
    profile,
    beats: components.map((name, i) => ({
      id: `b${String(i + 1).padStart(2, "0")}`, chapter: "ch1", key: { function: "HOOK", job: "map", content: "items", route: "none" }, row: "r1",
      beat: "list-beat", component: { name, maturity: "shipped" }, band: "concept",
      framing: varied ? ["full", "focus", "split", "stack"][i % 4] : "full", layer: varied && i % 2 === 0 ? "custom" : "template", anchors: [],
    })),
    budgets: [],
  });

describe("resolve stage variety checks", () => {
  const VARIETY = ["variety-top-component", "variety-component-run", "variety-template-share", "variety-framing-run", "variety-min-framings", "variety-cast-in-motion"];
  const variety = (run: ReturnType<typeof runStageChecks>) => run.checks.filter((check) => VARIETY.includes(check.name));

  it("passes every variety row on a varied resolve", () => {
    const run = runStageChecks("resolve", input({ resolved: resolvedArtifact(["ListBeat", "StatBeat", "CompareBeat", "CodeBeat", "MapBeat", "ListBeat", "StatBeat"], true) }));

    expect(variety(run).map((check) => [check.name, check.pass])).toEqual(VARIETY.map((name) => [name, true]));
  });

  it("reports a repetitive resolve, naming its beats, and fails no gate", () => {
    const run = runStageChecks("resolve", input({ resolved: resolvedArtifact(["ListBeat", "ListBeat", "ListBeat", "StatBeat"], false) }));

    expect(verdict(run, "variety-top-component")).toMatchObject({ gate: false, pass: false, detail: expect.stringContaining("ListBeat on 3 of 4 beats (75 %, at most 30 %): b01, b02, b03") });
    expect(verdict(run, "variety-component-run")).toMatchObject({ gate: false, pass: false, detail: "3 beats in a row share component ListBeat: b01, b02, b03" });
    expect(verdict(run, "variety-min-framings")).toMatchObject({ gate: false, pass: false });
    expect(failedGates(run.checks)).toEqual([]);
  });

  it("reads the resolved profile's limits, and an unknown profile is reported, not gated", () => {
    const run = runStageChecks("resolve", input({ resolved: resolvedArtifact(["ListBeat", "StatBeat"], true, "no-such-profile") }));

    expect(verdict(run, "variety-top-component")).toMatchObject({ gate: false, pass: false, detail: expect.stringContaining("unknown profile no-such-profile") });
    expect(failedGates(run.checks)).toEqual([]);
  });
});

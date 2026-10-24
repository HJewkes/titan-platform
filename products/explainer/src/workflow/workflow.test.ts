import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failingRubric, fakeRubricJudge, throwingRubric } from "../cold-rubric-fakes.test-helpers.js";
import type { L0Check } from "../eval-l0.js";
import { flowCheck } from "../lint-flow.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { sha256 } from "./artifacts.js";
import { MAX_REPAIR_ROUNDS } from "./model-stages.js";
import { resumeVideo, runVideo } from "./host.js";
import { STAGES } from "./records.js";
import { fakeBridge, fakeHost, fakeScriptModel, fakeVoice, fixture, l0Check, SPINE, spokenOf, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

/** A chapter order leading ch1 on verdict-card, whose emphasis target list is `reasons`. */
const LEAD_ORDER = "\n## 8. Chapter order\n| Chapter | Question | Rows | Beat |\n|---|---|---|---|\n| ch1 | Why does the desk refuse a parcel? | §3.1 | verdict-card |\n";

const row = (outcome: Awaited<ReturnType<typeof runVideo>>, stage: string) => outcome.report.rows.find((r) => r.stage === stage)!;

describe("explainer run", () => {
  it("runs every stage in order and ends with the MP4 linked into the theater", async () => {
    fx = fixture();
    const bridge = fakeBridge();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(result.status, result.error).toBe("completed");
    expect(result.report.rows.map((r) => [r.stage, r.status])).toEqual(STAGES.map((stage) => [stage, stage === "gather" || stage === "audition" ? "not run" : "ran"]));
    expect(bridge.calls).toEqual(["render.ts", "qa.ts", "sheets.sh", "variety.mjs"]);
    const theaterMp4 = path.join(fx.theater, "demo.mp4");
    expect(sha256(readFileSync(theaterMp4))).toBe(row(result, "render").outputs.mp4);
    expect(row(result, "export").outputs.mp4).toBe(row(result, "render").outputs.mp4);
  });

  it("files the reflection once when the same script exports a second time", async () => {
    fx = fixture();
    const spool = mkdtempSync(path.join(tmpdir(), "reflection-spool-"));
    const reflection = { mode: "deposit" as const, asker: "acme-seat", spoolDir: spool };
    const draft = choppy();
    const last = draft.chapters[draft.chapters.length - 1]!.id;
    const script = { ...draft, chapters: draft.chapters.map((c) => (c.id === last ? { ...c, id: "reflection" } : c)), beats: draft.beats.map((b) => (b.chapter === last ? { ...b, chapter: "reflection" } : b)) };
    const host = () => fakeHost(fx, fakeScriptModel(script), fakeBridge(), { reflection });

    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, host());
    const second = await runVideo({ spine: fx.spine, facts: fx.facts, from: "export", base: first.runId }, host());

    expect([first.status, second.status], first.error).toEqual(["completed", "completed"]);
    expect(readdirSync(spool).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(existsSync(path.join(fx.theater, "reflection.md"))).toBe(true);
    rmSync(spool, { recursive: true, force: true });
  });

  it("voices the rewritten script, not the draft", async () => {
    fx = fixture();
    const bridge = fakeBridge();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));

    expect(spokenOf(fx, row(result, "tts").outputs.words!)).toBe(spokenOf(fx, row(result, "rewrite").outputs.script!));
    expect(spokenOf(fx, row(result, "rewrite").outputs.script!)).not.toBe(spokenOf(fx, row(result, "script").outputs.draft!));
  });

  it("stops at the script stage's l0 gate when an error-severity L0 check fails, before the rewrite spends", async () => {
    fx = fixture();
    const bridge = fakeBridge();
    const model = fakeScriptModel();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, bridge, { evalChecks: [l0Check(false)] }));

    expect(result.status).toBe("failed");
    expect(model.prompts).toHaveLength(1 + MAX_REPAIR_ROUNDS);
    expect(row(result, "script")).toMatchObject({ status: "failed", checks: "9 pass, 1 gate fail, 1 reported fail" });
    expect(result.error).toContain("script: gate l0 failed");
    expect(bridge.calls).toEqual([]);
    expect(row(result, "rewrite").status).toBe("not run");
  });

  it("retries the script call once with the schema issues, and counts both calls", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { invalid: 1, usd: 0.05 });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[0]).toContain("## The script/v1 JSON Schema");
    expect(model.prompts[0]).toContain("Story spine: parcel-desk");
    expect(model.prompts[1]).toContain("Your previous reply was rejected");
    expect(row(result, "script")).toMatchObject({ retries: 1, calls: 2, usd: 0.1 });
  });

  // Mutation: dropping the cue-kind check from `checked` accepts the reply, so there is no retry and the prompt never names the kind.
  it("rejects a reply whose cue target kind is unknown, and the retry names the kind and the beat", async () => {
    fx = fixture();
    const script = choppy();
    const unknownKind = { ...script, beats: script.beats.map((beat, i) => (i === 0 ? { ...beat, visual: { ...beat.visual, cues: [{ action: "V6", target: "recipe-script:plan", atCue: "courier" }] } } : beat)) };
    const model = fakeScriptModel(script, { invalid: 1, invalidReply: unknownKind });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain(`cue target kind "recipe-script" in ${script.beats[0]!.id} is not one of job, inv,`);
  });

  // Mutation: returning the issue text for an unrecognized-keys-only reply (no strip) fails the stage after the retry.
  it("drops keys the schema does not allow on a beat and keeps the script, with a reported diagnostic and no retry", async () => {
    fx = fixture();
    const script = choppy();
    const withExtras = { ...script, beats: script.beats.map((beat, i) => (i < 2 ? { ...beat, chips: ["extra"], cues: [] } : beat)) };
    const model = fakeScriptModel(script, { invalid: 1, invalidReply: withExtras });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(1);
    expect(row(result, "script")).toMatchObject({ retries: 0, checks: "10 pass, 0 gate fail, 1 reported fail" });
    const draft = JSON.parse(readFileSync(path.join(fx.dataDir, "artifacts", row(result, "script").outputs.draft!), "utf8"));
    expect(draft.beats[0]).not.toHaveProperty("chips");
    expect(draft.beats[1]).not.toHaveProperty("cues");
    expect(draft.beats.flatMap((beat: { new_terms: string[] }) => beat.new_terms)).toContain("desk server");
  });

  it("names an unknown key in the schema retry when the reply has other faults too, and recovers there", async () => {
    fx = fixture();
    const script = choppy();
    const broken = { ...script, chapters: [], beats: script.beats.map((beat, i) => (i === 0 ? { ...beat, cues: [] } : beat)) };
    const model = fakeScriptModel(script, { invalid: 1, invalidReply: broken });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain('Unrecognized key: "cues"');
    expect(row(result, "script")).toMatchObject({ retries: 1, checks: "10 pass, 0 gate fail, 0 reported fail" });
  });

  it("repairs a draft that fails L0 with one call naming the failing checks, and keeps the repair", async () => {
    fx = fixture();
    const draft = choppy();
    const model = fakeScriptModel(draft, { repaired: { ...draft, id: `${draft.id}-repaired` } });
    const passesOnceRepaired: L0Check = (input) => l0Check(input.script.id.endsWith("-repaired"))(input);

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge(), { evalChecks: [passesOnceRepaired] }));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("## Checks the draft fails\n\n- fake-l0:");
    expect(row(result, "script")).toMatchObject({ calls: 2, retries: 0, checks: "11 pass, 0 gate fail, 0 reported fail" });
  });

  it("tells the repair what a failing check found where its row alone is opaque", async () => {
    fx = fixture();
    const draft = choppy();
    const model = fakeScriptModel({ ...draft, video: { ...draft.video, thesis_refs: [draft.beats[0]!.id, draft.beats[1]!.id, draft.beats.at(-1)!.id] } });

    await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge(), { evalChecks: [flowCheck] }));

    expect(model.prompts[1]).toMatch(/\n- Q-F4: .*\n {2}Found: the midpoint thesis ref /);
  });

  // Mutation: dropping unknownWordsRow from the repair's rows sends no repair call, and the unknown-words gate fails.
  it("puts a word the voice cannot say into the repair round with its split, and keeps the respelled reply", async () => {
    fx = fixture();
    const joined = choppy({ h2: { spoken: "The desk checks every parcel with shelfscan today." } });
    const model = fakeScriptModel(joined, { repaired: choppy({ h2: { spoken: "The desk checks every parcel with shelf scan today." } }) });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, to: "script" }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toMatch(/\n- unknown-words: every spoken word must be one the voice has phonemes for \(beats: h2\b.*\n {2}Found: the voice has no phonemes for h2 "shelfscan" \(write "shelf scan"\)/);
  });

  // Mutation: keeping the reply's structure records bluf, which the spine was never planned under.
  it("records the planned design-journey structure on the draft, whatever the reply names", async () => {
    fx = fixture();
    const model = fakeScriptModel({ ...choppy(), structure: "bluf" });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    const draft = JSON.parse(readFileSync(path.join(fx.dataDir, "artifacts", row(result, "script").outputs.draft!), "utf8"));
    expect(draft.structure).toBe("design-journey");
  });

  // Mutation: stamping GUIDE_PLAN_STRUCTURE, or keeping the reply's profile, stores design-journey or daily-briefing.
  it("records the run's profile and the spine's structure on the draft, and names the lead beat's targets in the prompt", async () => {
    fx = fixture();
    writeFileSync(fx.spine, SPINE.replace("\n\n## 3. Journey", `\n\nStructure: scqa\n\n## 3. Journey`) + LEAD_ORDER);
    const model = fakeScriptModel({ ...choppy(), profile: "daily-briefing", structure: "design-journey" }, { followLeads: true });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, profile: "daily-overview", to: "script" }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    const draft = JSON.parse(readFileSync(path.join(fx.dataDir, "artifacts", row(result, "script").outputs.draft!), "utf8"));
    expect(draft).toMatchObject({ profile: "daily-overview", structure: "scqa" });
    expect(model.prompts[0]).toContain("- ch1: verdict-card (emphasis targets: reasons).");
  });

  it("retries a reply that leaves a lead beat uncued, naming the chapter", async () => {
    fx = fixture();
    writeFileSync(fx.spine, SPINE + LEAD_ORDER);
    const model = fakeScriptModel(choppy(), { invalid: 1, invalidReply: choppy(), followLeads: true });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, to: "script" }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts[1]).toContain("lead beats: ch1's lead beat verdict-card is on none of its beats");
  });

  it("makes no repair call for a draft that passes L0", async () => {
    fx = fixture();
    const model = fakeScriptModel();

    await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(model.prompts).toHaveLength(1);
  });

  it("fails the script stage after one retry, keeping both calls' spend in the report", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { invalid: 2, usd: 0.05 });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    expect(result.status).toBe("failed");
    expect(model.prompts).toHaveLength(2);
    expect(row(result, "script")).toMatchObject({ status: "failed", usd: 0.1, retries: 1 });
    expect(result.report.totals.usd).toBeCloseTo(0.1);
  });
});

describe("the cold rubric on every run", () => {
  it("scores J8 to J12 on the final script and records them as a note and an artifact, never a check", async () => {
    fx = fixture();
    const host = fakeHost(fx, fakeScriptModel(), fakeBridge());

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, host);

    const evalRow = row(result, "eval");
    expect(host.rubric.calls).toHaveLength(1);
    expect(evalRow.outputs["cold-rubric"]).toMatch(/^[0-9a-f]{64}$/);
    expect(evalRow.notes[0]).toMatch(/^cold rubric \(reported only\): J8 \d, J9 \d, J10 \d, J11 \d, J12 \d; canary held$/);
    expect(evalRow.checks).toBe("2 pass, 0 gate fail, 0 reported fail");
  });

  // Mutation: adding the rubric to the eval stage's checks, failing below 3 or on a missed canary, fails this test.
  it.each([
    ["scores every row 1 and misses its canary", fakeRubricJudge({ score: 1, lenient: true }).harness],
    ["fails its call", failingRubric],
    ["throws", throwingRubric],
  ])("cannot fail the run or gate a stage when the rubric judge %s", async (_, harness) => {
    fx = fixture();
    const bridge = fakeBridge();
    const rubric = { harness, calls: [] as string[] };

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge, { rubric }));

    expect(result.status, result.error).toBe("completed");
    expect(row(result, "eval").checks).toBe("2 pass, 0 gate fail, 0 reported fail");
    expect(row(result, "eval").notes[0]).toMatch(/^cold rubric \(reported only\)/);
    expect(bridge.calls).toEqual(["render.ts", "qa.ts", "sheets.sh", "variety.mjs"]);
  });
});

describe("explainer run --from", () => {
  it("from tts spends nothing on models, and the unchanged script hits the stage cache from tts on", async () => {
    fx = fixture();
    const model = fakeScriptModel();
    const bridge = fakeBridge();
    const first = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, bridge));
    const host = fakeHost(fx, model, bridge);

    const second = await runVideo({ from: "tts" }, host);

    expect(second.status, second.error).toBe("completed");
    expect(model.prompts).toHaveLength(1);
    expect(host.rewriter.prompts).toHaveLength(0);
    expect(second.report.totals.usd).toBe(0);
    expect(spokenOf(fx, row(second, "tts").outputs.words!)).toBe(spokenOf(fx, row(first, "rewrite").outputs.script!));
    for (const stage of ["script", "rewrite", "eval"]) {
      expect(row(second, stage)).toMatchObject({ status: "reused", cacheHit: true, usd: 0, wallMs: 0, outputs: row(first, stage).outputs, reusedFrom: first.runId });
    }
    for (const stage of ["tts", "render", "qa", "sheets"]) {
      expect(row(second, stage)).toMatchObject({ status: "cached", cacheHit: true, wallMs: 0, outputs: row(first, stage).outputs, childRunId: row(first, stage).childRunId });
    }
    expect(second.report.linked).toEqual([{ runId: first.runId, usd: first.report.totals.usd }]);
  });

  it("refuses a --from whose base run never finished the stages before it, naming the stage", async () => {
    fx = fixture();
    const bridge = fakeBridge({ qaFails: true });
    const failed = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), bridge));

    await expect(runVideo({ from: "sheets", base: failed.runId }, fakeHost(fx, fakeScriptModel(), bridge))).rejects.toThrow(/has no completed qa stage/);
  });
});

describe("spend cap", () => {
  it("stops before the next stage once spend reaches the cap, naming that stage", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { usd: 0.05 });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, budgetUsd: 0.05 }, fakeHost(fx, model, fakeBridge()));

    expect(result.status).toBe("failed");
    expect(result.report.stop).toEqual({ stage: "rewrite", spentUsd: 0.05, capUsd: 0.05 });
    expect(row(result, "rewrite").status).toBe("not run");
    expect(readFileSync(result.reportPath, "utf8")).toContain("Stopped at the spend cap before stage rewrite");
  });

  it("resumes a stopped run from the named stage under a higher cap, without paying for the script again", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { usd: 0.05 });
    const bridge = fakeBridge();
    const stopped = await runVideo({ spine: fx.spine, facts: fx.facts, budgetUsd: 0.05 }, fakeHost(fx, model, bridge));

    const resumed = await resumeVideo(stopped.runId, fakeHost(fx, model, bridge), { budgetUsd: 5 });

    expect(resumed.status, resumed.error).toBe("completed");
    expect(resumed.report.from).toBe("rewrite");
    expect(model.prompts).toHaveLength(1);
    expect(row(resumed, "script")).toMatchObject({ status: "reused", outputs: row(stopped, "script").outputs });
    expect(resumed.report.videoUsd).toBeCloseTo(0.05 + resumed.report.totals.usd);
  });

  it("caps the script call's own budget at what the run has left", async () => {
    fx = fixture();
    const model = fakeScriptModel();

    await runVideo({ spine: fx.spine, facts: fx.facts, budgetUsd: 1.5 }, fakeHost(fx, model, fakeBridge()));

    expect(model.budgets).toEqual([1.5]);
  });
});

describe("bridged stages", () => {
  it("fails the run at the stage whose command exits non-zero, and a resume starts there", async () => {
    fx = fixture();
    const failing = fakeBridge({ qaFails: true });
    const failed = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), failing));
    const bridge = fakeBridge();

    const resumed = await resumeVideo(failed.runId, fakeHost(fx, fakeScriptModel(), bridge));

    expect(failed.error).toContain("bridge qa: command 1 (qa.ts) exited 1: held errors at b1");
    expect(row(failed, "qa")).toMatchObject({ status: "failed", checks: "0 pass, 1 gate fail, 0 reported fail" });
    expect(resumed.status, resumed.error).toBe("completed");
    expect(bridge.calls).toEqual(["qa.ts", "sheets.sh", "variety.mjs"]);
  });

  it("writes each command's output to the run's log directory", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const qaChild = row(result, "qa").childRunId!;
    expect(readFileSync(path.join(fx.dataDir, "runs", qaChild, "logs", "qa-1.log"), "utf8")).toContain("qa PASS demo");
  });
});

describe("checks as stage steps", () => {
  /** h1 shows a V6 card on "courier", a word h1 speaks in the draft and in its rewrite. */
  const cued = () => choppy({ h1: { visual: { assertion: "The desk refuses unknown parcels", job: "numbers", cues: [{ action: "V6", target: "card", atCue: "courier" }] } } });

  it("fails the tts stage when the voice has no phonemes for a word, before render", async () => {
    fx = fixture();
    const bridge = fakeBridge();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(cued()), bridge, { ttsEngine: fakeVoice({ dropWord: "courier" }).engine }));

    expect(result.status).toBe("failed");
    expect(result.error).toContain('no phonemes for 1 word(s): "courier"');
    expect(row(result, "tts").status).toBe("failed");
    expect(row(result, "render").status).toBe("not run");
    expect(bridge.calls).toEqual([]);
  });

  it("passes the cue gate when every cue word is voiced", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(cued()), fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(row(result, "tts").checks).toBe("1 pass, 0 gate fail, 0 reported fail");
  });

  it("records a failed reported-only bridge check and runs on to the theater", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge({ varietyFails: true })));

    expect(result.status, result.error).toBe("completed");
    expect(row(result, "sheets").checks).toBe("0 pass, 0 gate fail, 1 reported fail");
    expect(readFileSync(result.reportPath, "utf8")).toContain("| sheets | variety | reported | **fail** | variety WARN: 3 beats in a row share a framing |");
  });

  it("lists every stage's verdicts with their role in the report", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const md = readFileSync(result.reportPath, "utf8");
    expect(md).toContain("| script | l0 | gate | pass |");
    expect(md).toContain("| rewrite | rewrite-rows | reported |");
    expect(md).toContain("| tts | cue-resolution | gate | pass | 0 of 0 cues resolve |");
  });
});

describe("run report", () => {
  it("gives each stage its wall time, usd, tokens and shares, and totals that add up", async () => {
    fx = fixture();
    const model = fakeScriptModel(undefined, { usd: 0.05 });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, model, fakeBridge()));

    const { report } = result;
    const rewrite = row(result, "rewrite");
    // One clock read for the body's start and one each for its end and the checks step's end; export has no checks step.
    expect(report.rows.filter((r) => r.status !== "not run").map((r) => r.wallMs)).toEqual([...Array(8).fill(2000), 1000]);
    expect(report.totals.wallMs).toBe(17000);
    expect(row(result, "script")).toMatchObject({ usd: 0.05, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, calls: 1 });
    expect(rewrite.usd).toBeGreaterThan(0);
    expect(row(result, "eval")).toMatchObject({ usd: 0.01, calls: 1 });
    expect(report.totals.usd).toBeCloseTo(0.05 + rewrite.usd + 0.01);
    expect(report.totals.calls).toBe(1 + rewrite.calls + 1);
  });

  it("marks exactly the bridged stages, and lists each stage's output shas", async () => {
    fx = fixture();

    const result = await runVideo({ spine: fx.spine, facts: fx.facts }, fakeHost(fx, fakeScriptModel(), fakeBridge()));

    const md = readFileSync(result.reportPath, "utf8");
    const bridgedRows = md.split("\n").filter((line) => line.includes("**bridge**")).map((line) => line.split("|")[1]!.trim());
    expect(bridgedRows).toEqual(["render", "qa", "sheets"]);
    expect(md).toContain(`mp4 ${row(result, "render").outputs.mp4!.slice(0, 12)}`);
    expect(md).toContain("qa PASS demo: 0 held errors");
    expect(existsSync(result.reportPath.replace(/\.md$/, ".json"))).toBe(true);
  });
});

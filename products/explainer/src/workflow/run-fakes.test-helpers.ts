import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TtsUnknownWordsError, type TtsProvider } from "@titan-design/speech-tts";
import { plainText } from "@titan-design/speech-vet";
import type { AgentRunnerOptions, StepRunInput, StepRunOutcome } from "@titan-design/workflow";
import { fakeAuditionModel } from "../audition-fakes.test-helpers.js";
import { fakeRubricJudge, routeRubric } from "../cold-rubric-fakes.test-helpers.js";
import { emphasisTargets, loadBeatSpecs } from "../beat-load.js";
import type { L0Check } from "../eval-l0.js";
import { choppy, fakeRewriter } from "../rewrite-fixtures.test-helpers.js";
import { loadProfiles } from "../profile-load.js";
import { beatsFor } from "../script-budget.js";
import { draftFill } from "../script-fill.js";
import type { ScriptBeat, ScriptV1 } from "../script-schema.js";
import { FillError } from "../template-fill/fill.js";
import { sha256 } from "./artifacts.js";
import { z } from "zod";
import { runVideo, type RunHost, type RunOutcome, type RunRequest } from "./host.js";
import type { MediaExec } from "./sheets-stage.js";
import type { TtsEngine } from "./tts-stage.js";
import { fakeQa } from "../qa/qa-fakes.test-helpers.js";
import { treeSha } from "../render/composition-page.js";
import { fakeRenderDeps, type FakeRenderOptions } from "../render/render-fakes.test-helpers.js";
import type { RenderEngine } from "../render/render-stage.js";
import { renderVideo, type RenderInput } from "../render/render-video.js";
import { PACING_DEFAULTS, type TimingProfile } from "../qa/timing-gates.js";

/** A synthetic spine with the four required tables; nothing here quotes a real video. */
export const SPINE = `# Story spine: parcel-desk

## 3. Journey
| # | Step | What | Why | Invariant | Today |
|---|---|---|---|---|---|
| 1 | Scan | a scanner reads the label | the ledger would miss the parcel | — | — |

## 4. Architecture
| Part | Carries | Mechanism | Constraint |
|---|---|---|---|
| Desk server | 1 | — | — |

## 5. Constraints
| Constraint | Forces |
|---|---|

## 6. Ledger
| Item | Kind | Defined in | Reused in |
|---|---|---|---|
| desk server | part | ch2 | — |
`;

const FACTS = "# Facts\n\n| Id | Claim |\n|---|---|\n| F1 | Every scan passes the desk server. |\n";

export interface Fixture {
  dataDir: string;
  /** A stand-in for the built composition page. */
  page: string;
  theater: string;
  spine: string;
  facts: string;
  cleanup: () => void;
}

export function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "explainer-run-"));
  const dirs = { dataDir: path.join(root, "data"), page: path.join(root, "page"), theater: path.join(root, "theater") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const file = { schema: "explainer-bridge/v1", theater: { dir: dirs.theater, stem: "demo", files: { mp4: ".mp4", vtt: ".vtt" } } };
  writeFileSync(path.join(dirs.dataDir, "bridge.json"), JSON.stringify(file));
  writeFileSync(path.join(dirs.page, "index.html"), "<!doctype html><html><head><title>fake composition</title></head><body></body></html>\n");
  const spine = path.join(root, "spine.md");
  const facts = path.join(root, "facts.md");
  writeFileSync(spine, SPINE);
  writeFileSync(facts, FACTS);
  return { ...dirs, spine, facts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface FakeRender {
  /** The render stage's engine over the fixture's stand-in page, with renderVideo on fake capture and encode. */
  engine: (fx: Fixture) => RenderEngine;
  /** Each render's input, in order. */
  renders: RenderInput[];
}

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** Renders in process with no browser and no ffmpeg, and records each render's input. */
export function fakeRender(options: FakeRenderOptions = {}): FakeRender {
  const renders: RenderInput[] = [];
  const deps = fakeRenderDeps(options);
  const engine = (fx: Fixture): RenderEngine => ({
    page: async () => ({ dir: fx.page, sha: treeSha(fx.page) }),
    render: (input) => {
      renders.push(input);
      return renderVideo(input, deps);
    },
  });
  return { engine, renders };
}

const FAKE_DURATION_S = 200;

/** ffprobe and ffmpeg on the fake render's text MP4: a fixed duration, and a "frame" naming its time and the video's hash. */
export function fakeMedia(durationS = FAKE_DURATION_S): MediaExec & { frames: number[] } {
  const frames: number[] = [];
  return {
    frames,
    durationS: async () => durationS,
    frame: async (mp4, atS, widthPx, out) => {
      frames.push(atS);
      write(out, `jpg:${widthPx}:${atS}:${sha256(readFileSync(mp4))}`);
    },
  };
}

export interface FakeScriptModel {
  runnerFor: (options: AgentRunnerOptions) => { run: (input: StepRunInput) => Promise<StepRunOutcome> };
  prompts: string[];
  budgets: number[];
}

const LEAD_LINE = /^- (\S+): ([a-z0-9-]+) \(emphasis targets: ([^)]+)\)/gm;

/** `script` with its chapters, in order, under the ids the prompt's lead beats name, as a model keeping the spine's ids would. */
function withLeadChapters(script: ScriptV1, ids: readonly string[]): ScriptV1 {
  if (ids.length !== script.chapters.length || ids.every((id) => script.chapters.some((chapter) => chapter.id === id))) return script;
  const renamed = new Map(script.chapters.map((chapter, i) => [chapter.id, ids[i]!]));
  const chapters = script.chapters.map((chapter) => ({ ...chapter, id: renamed.get(chapter.id)! }));
  return { ...script, chapters, beats: script.beats.map((beat) => ({ ...beat, chapter: renamed.get(beat.chapter)! })) };
}

/**
 * The lead beats cued again as a model answering the template-fill hint would: a beat that falls back cues the first
 * element of the kind it draws instead.
 */
function onDrawnElements(script: ScriptV1, leads: ReadonlySet<string>): ScriptV1 {
  const filled = draftFill(script);
  if (filled instanceof FillError) return script;
  const specs = loadBeatSpecs();
  const first = new Map(filled.beats.filter((beat) => beat.fallback && leads.has(beat.id)).map((beat) => [beat.id, emphasisTargets(specs.get(beat.spec)!, beat.slots)[0]]));
  return { ...script, beats: script.beats.map((beat) => {
    const target = first.get(beat.id);
    return target === undefined ? beat : { ...beat, visual: { ...beat.visual, cues: beat.visual.cues.slice(0, 1).map((cue) => ({ ...cue, target })) } };
  }) };
}

/** `script` with each lead beat the prompt lists on its chapter's first beat, cued once per target on a word it speaks. */
function withLeadBeats(written: ScriptV1, prompt: string): ScriptV1 {
  const leads = new Map([...prompt.matchAll(LEAD_LINE)].map(([, chapter, spec, targets]) => [chapter!, { spec: spec!, targets: targets!.split(", ") }]));
  const script = withLeadChapters(written, [...leads.keys()]);
  const beats = script.beats.map((beat) => {
    const lead = leads.get(beat.chapter);
    if (!lead || script.beats.find((b) => b.chapter === beat.chapter) !== beat) return beat;
    const word = beat.spoken.split(/\s+/).find((w) => /^[A-Za-z]+$/.test(w))!;
    const cues = lead.targets.map((target) => ({ action: "V6" as const, target: `${target}-1`, atCue: word }));
    return { ...beat, visual: { ...beat.visual, beat: lead.spec, cues } };
  });
  const leadIds = new Set(beats.filter((beat, i) => beat !== script.beats[i]).map((beat) => beat.id));
  return onDrawnElements({ ...script, beats }, leadIds);
}

const PROMPT_RUNTIME = /plannedS sum to about (\d+) s/;

/**
 * `script` with its beats' plannedS scaled to the runtime the prompt names, else its own profile's target, and each beat
 * the scaling pushes past Q-F8's band split; a script whose profile is unknown and a prompt naming no runtime leave it as written.
 */
function atTargetRuntime(script: ScriptV1, prompt: string): ScriptV1 {
  const named = PROMPT_RUNTIME.exec(prompt)?.[1];
  const targetS = named ? Number(named) : loadProfiles().profiles.get(script.profile)?.runtime.targetS;
  if (targetS === undefined) return script;
  const total = script.beats.reduce((sum, beat) => sum + beat.plannedS, 0);
  const scale = targetS / total;
  const beats = script.beats.map((beat) => ({ ...beat, plannedS: Math.round(beat.plannedS * scale) }));
  return { ...script, beats: beats.flatMap(splitBeat) };
}

/** A beat over Q-F8's band as the script stage's beat plan splits it: the first part keeps its id, each continuation beat repeats its words. */
function splitBeat(beat: ScriptBeat): ScriptBeat[] {
  const parts = beat.function === "CLOSE" ? 1 : beatsFor(beat.plannedS);
  const each = Math.floor(beat.plannedS / parts);
  return Array.from({ length: parts }, (_, i) => ({
    ...beat,
    id: i === 0 ? beat.id : `${beat.id}-${i + 1}`,
    plannedS: i === 0 ? beat.plannedS - each * (parts - 1) : each,
  }));
}

/** The script model: answers with `script`, after `invalid` replies that fail the schema, at `usd` a call. */
/** `invalidReply` is what each of the first `invalid` calls answers; by default the script with no chapters. */
/** `followLeads` places the prompt's lead beats on the reply, as a model following the prompt would. */
/** Each reply plans the prompt's target runtime unless `asWritten` keeps the script's own plannedS. */
export function fakeScriptModel(
  script: ScriptV1 = choppy(),
  options: { invalid?: number; invalidReply?: unknown; usd?: number; repaired?: ScriptV1; followLeads?: boolean; asWritten?: boolean } = {},
): FakeScriptModel {
  const prompts: string[] = [];
  const budgets: number[] = [];
  let bad = options.invalid ?? 0;
  const usage = { costUsd: options.usd ?? 0.05, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 };
  const runnerFor = (runner: AgentRunnerOptions) => ({
    run: async (input: StepRunInput): Promise<StepRunOutcome> => {
      prompts.push(input.prompt);
      budgets.push(runner.maxBudgetUsd);
      if (bad-- > 0) return { ok: true, output: JSON.stringify(options.invalidReply ?? { ...script, chapters: [] }), usage };
      const written = options.repaired && input.prompt.includes("## Checks the draft fails") ? options.repaired : script;
      const answer = options.asWritten ? written : atTargetRuntime(written, input.prompt);
      const reply = options.followLeads ? withLeadBeats(answer, input.prompt) : answer;
      return { ok: true, output: `Here is the script.\n\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`\n`, usage };
    },
  });
  return { runnerFor, prompts, budgets };
}

/** The decision brief's two models: the sampling call answers the audition's prompt, `script` the script stage's. */
export function fakeBriefModels(script = fakeScriptModel(choppy(), { followLeads: true })): FakeScriptModel & { script: FakeScriptModel } {
  const audition = fakeAuditionModel();
  const runnerFor = (options: AgentRunnerOptions) => {
    const sampler = audition.runnerFor(options);
    const writer = script.runnerFor(options);
    return { run: (input: StepRunInput) => (input.stepId === "audition" ? sampler : writer).run(input) };
  };
  return { runnerFor, prompts: [], budgets: [], script };
}

/** One L0 row, so a test picks the eval stage's verdict without writing a script the whole L0 set passes. */
export const l0Check = (pass: boolean): L0Check => () => [{ check_id: "fake-l0", mode: "tagged", severity: "error", value: pass ? 0 : 1, threshold: 0, pass, detail_beats: [] }];

type Fakes = { rewriter: ReturnType<typeof fakeRewriter>; rubric: ReturnType<typeof fakeRubricJudge> };

/** A host on fakes, with a clock that moves one second per read so stage wall times are exact; `rubric` judges J8 to J12. */
interface FakeVoice {
  engine: () => Promise<TtsEngine>;
  /** The text of every take synthesized, in order; a take the cache served is not here. */
  spoken: string[];
}

const FAKE_RATE = 1000;

/** A voice that speaks one word a second and times each word itself; `dropWord` has no phonemes, as Kokoro's strict mode refuses. */
export function fakeVoice(options: { dropWord?: string } = {}): FakeVoice {
  const spoken: string[] = [];
  const provider: TtsProvider = {
    id: "fake-voice",
    capabilities: { phonemeInput: [], wordTimestamps: true, speedControl: true, voices: [], languages: ["en-US"], sampleRate: FAKE_RATE },
    synthesize: async (input, _voice, synthesis) => {
      // Like Kokoro's g2p, it hears a `[w](=reading)` declaration as its word.
      const words = plainText("text" in input ? input.text : "").split(/\s+/).filter(Boolean);
      const unknown = words.map((word, index) => ({ word, index })).filter((w) => w.word === options.dropWord);
      if (unknown.length > 0) throw new TtsUnknownWordsError("fake-voice", unknown);
      spoken.push(words.join(" "));
      // A word a second at speed 1, faster with speed, so the stage's rate calibration settles in two tries.
      const slot = 1 / (synthesis?.speed ?? 1);
      const audio = { samples: new Float32Array(Math.round(words.length * slot * FAKE_RATE)).fill(0.1), sampleRate: FAKE_RATE };
      return { audio, durationS: words.length * slot, words: words.map((word, i) => ({ word, start: i * slot, end: (i + 1) * slot })) };
    },
  };
  return { engine: async () => ({ provider, version: "fake/1" }), spoken };
}

const SpokenSchema = z.object({ beats: z.array(z.object({ spoken: z.string() })) });

/** The spoken text, one beat a line, of a script/v1 or a words.json in the fixture's store. */
export function spokenOf(fx: Fixture, sha: string): string {
  const { beats } = SpokenSchema.parse(JSON.parse(readFileSync(path.join(fx.dataDir, "artifacts", sha), "utf8")));
  return beats.map((beat) => beat.spoken).join("\n");
}

/** The fixture's beats run 16-18 s with no cues, so the DIRECTION timing gates would stop every run at qa; these never fire. */
const LAX_TIMING: TimingProfile = { pacing: { ...PACING_DEFAULTS, pictureChangeMaxS: 600, pictureChangeFailS: 600, staticMaxS: 600, held: [0, 600] } };

export function fakeHost(fx: Fixture, model: FakeScriptModel, render: FakeRender, extra: Partial<RunHost & Fakes> = {}): RunHost & Fakes {
  const rewriter = extra.rewriter ?? fakeRewriter();
  const rubric = extra.rubric ?? fakeRubricJudge();
  let tick = Date.parse("2026-10-22T00:00:00Z");
  const now = () => new Date((tick += 1000));
  const harnessFor = () => routeRubric(rubric.harness, rewriter.harness);
  // No beat worker unless a test passes one: the default would spawn a real claude wherever one is installed.
  const media = { media: fakeMedia(), qaEngine: fakeQa(), qaTiming: LAX_TIMING };
  // Nor a layer text check: the default renders each layer in Chromium.
  const layers = { beatWorker: null, layerTextCheck: null };
  const seams = { runnerFor: model.runnerFor, harnessFor, renderEngine: render.engine(fx), ttsEngine: fakeVoice().engine, ...media, evalChecks: [l0Check(true)], now, ...layers };
  return { dataDir: fx.dataDir, ...seams, ...extra, rewriter, rubric };
}

interface SeededRun {
  /** The seed's own fixture: read it, never run in it; `cloneFixture` gives a test its own copy. */
  fx: Fixture;
  model: FakeScriptModel;
  render: FakeRender;
  host: RunHost & Fakes;
  result: RunOutcome;
}

const seeds = new Map<string, Promise<SeededRun>>();

/**
 * One run on the default fakes per `request`, made on first call and shared by every later call in the test file, so
 * tests that only read a default run, or start from one, skip the pipeline. A test that asserts first-run cache misses
 * makes its own run.
 */
export function seededRun(request: Omit<RunRequest, "spine" | "facts"> = {}): Promise<SeededRun> {
  const key = JSON.stringify(request);
  let seed = seeds.get(key);
  if (!seed) {
    seed = seedRun(request);
    seeds.set(key, seed);
  }
  return seed;
}

async function seedRun(request: Omit<RunRequest, "spine" | "facts">): Promise<SeededRun> {
  const fx = fixture();
  const model = fakeScriptModel();
  const render = fakeRender();
  const host = fakeHost(fx, model, render);
  const result = await runVideo({ spine: fx.spine, facts: fx.facts, ...request }, host);
  return { fx, model, render, host, result };
}

/** Removes every seed's fixture; a file that seeds calls it in `afterAll`. */
export async function dropSeeds(): Promise<void> {
  const all = await Promise.all(seeds.values());
  seeds.clear();
  for (const seed of all) seed.fx.cleanup();
}

/**
 * A copy of the seed's fixture with its data dir, sqlite state and artifacts, mtimes kept so cache freshness reads
 * the same, and its bridge pointed at the copy's own theater.
 */
export function cloneFixture(seed: Pick<SeededRun, "fx">): Fixture {
  const from = path.dirname(seed.fx.dataDir);
  const root = mkdtempSync(path.join(tmpdir(), "explainer-run-"));
  cpSync(from, root, { recursive: true, preserveTimestamps: true });
  const at = (file: string) => path.join(root, path.relative(from, file));
  const fx = { dataDir: at(seed.fx.dataDir), page: at(seed.fx.page), theater: at(seed.fx.theater), spine: at(seed.fx.spine), facts: at(seed.fx.facts) };
  const bridgeFile = path.join(fx.dataDir, "bridge.json");
  const bridge = JSON.parse(readFileSync(bridgeFile, "utf8"));
  writeFileSync(bridgeFile, JSON.stringify({ ...bridge, theater: { ...bridge.theater, dir: fx.theater } }));
  return { ...fx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TtsUnknownWordsError, type TtsProvider } from "@titan-design/speech-tts";
import type { AgentRunnerOptions, StepRunInput, StepRunOutcome } from "@titan-design/workflow";
import { fakeAuditionModel } from "../audition-fakes.test-helpers.js";
import { fakeRubricJudge, routeRubric } from "../cold-rubric-fakes.test-helpers.js";
import type { L0Check } from "../eval-l0.js";
import { choppy, fakeRewriter } from "../rewrite-fixtures.test-helpers.js";
import type { ScriptV1 } from "../script-schema.js";
import { sha256 } from "./artifacts.js";
import { z } from "zod";
import type { BridgeExec, BridgeFileSchema, ExecRequest } from "./bridge.js";
import type { RunHost } from "./host.js";
import type { TtsEngine } from "./tts-stage.js";

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
  workdir: string;
  theater: string;
  spine: string;
  facts: string;
  cleanup: () => void;
}

const BRIDGE: Omit<z.input<typeof BridgeFileSchema>, "workdir" | "theater"> = {
  schema: "explainer-bridge/v1",
  stages: {
    render: {
      inputs: { words: "out/words.json", audio: "out/audio" },
      outputs: { mp4: { path: "out/demo.mp4", tree: false }, vtt: { path: "out/demo.vtt", tree: false } },
      commands: [{ argv: ["node", "tools/render.ts", "{out.mp4}", "--workers", "{var.workers}"], timeoutS: 60 }],
      vars: { workers: "4" },
    },
    qa: { inputs: { mp4: "out/demo.mp4" }, outputs: { qa: { path: "out/qa.json", tree: false } }, commands: [{ argv: ["node", "tools/qa.ts"], timeoutS: 60, check: "qa" }], vars: {} },
    sheets: {
      inputs: { mp4: "out/demo.mp4" },
      outputs: { sheet: { path: "out/sheet.png", tree: false } },
      commands: [{ argv: ["sh", "tools/sheets.sh"], timeoutS: 60 }, { argv: ["node", "tools/variety.mjs"], timeoutS: 60, check: "variety", gate: false }],
      vars: {},
    },
  },
};

export function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "explainer-run-"));
  const dirs = { dataDir: path.join(root, "data"), workdir: path.join(root, "work"), theater: path.join(root, "theater") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const file = { ...BRIDGE, workdir: dirs.workdir, theater: { dir: dirs.theater, stem: "demo", files: { mp4: ".mp4", vtt: ".vtt" } } };
  writeFileSync(path.join(dirs.dataDir, "bridge.json"), JSON.stringify(file));
  const spine = path.join(root, "spine.md");
  const facts = path.join(root, "facts.md");
  writeFileSync(spine, SPINE);
  writeFileSync(facts, FACTS);
  return { ...dirs, spine, facts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface FakeBridge {
  exec: BridgeExec;
  /** Each command's script name, in order. */
  calls: string[];
}

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const at = (req: ExecRequest, rel: string) => path.join(req.cwd, rel);

interface BridgeOptions {
  qaFails?: boolean;
  /** The variety lint (a reported-only check) exits non-zero. */
  varietyFails?: boolean;
}

/** Each template command's stand-in, by script name: it writes what the real one would, derived from its inputs. */
function templateBodies(options: BridgeOptions): Record<string, (req: ExecRequest) => { code: number; stdout: string }> {
  return {
    "render.ts": (req) => {
      write(req.argv[2]!, `mp4:workers=${req.argv[4]}:${readFileSync(at(req, "out/words.json"), "utf8")}`);
      write(at(req, "out/demo.vtt"), "WEBVTT\n");
      return { code: 0, stdout: '{"frames":30}\n' };
    },
    "qa.ts": (req) => {
      write(at(req, "out/qa.json"), JSON.stringify({ pass: !options.qaFails }));
      return options.qaFails ? { code: 1, stdout: "qa FAIL demo: 1 held errors\n" } : { code: 0, stdout: "qa PASS demo: 0 held errors, 2 moments\n" };
    },
    "sheets.sh": (req) => {
      write(at(req, "out/sheet.png"), `png:${sha256(readFileSync(at(req, "out/demo.mp4")))}`);
      return { code: 0, stdout: "" };
    },
    "variety.mjs": () => (options.varietyFails ? { code: 1, stdout: "variety WARN: 3 beats in a row share a framing\n" } : { code: 0, stdout: "variety ok\n" }),
  };
}

/** Stands in for the template commands and records which ran. */
export function fakeBridge(options: BridgeOptions = {}): FakeBridge {
  const calls: string[] = [];
  const bodies = templateBodies(options);
  const exec: BridgeExec = async (req) => {
    const name = path.basename(req.argv[1]!);
    calls.push(name);
    const { code, stdout } = bodies[name]!(req);
    return { code, stdout, stderr: code === 0 ? "" : "held errors at b1\n" };
  };
  return { exec, calls };
}

interface FakeScriptModel {
  runnerFor: (options: AgentRunnerOptions) => { run: (input: StepRunInput) => Promise<StepRunOutcome> };
  prompts: string[];
  budgets: number[];
}

/** The script model: answers with `script`, after `invalid` replies that fail the schema, at `usd` a call. */
export function fakeScriptModel(script: ScriptV1 = choppy(), options: { invalid?: number; usd?: number; repaired?: ScriptV1 } = {}): FakeScriptModel {
  const prompts: string[] = [];
  const budgets: number[] = [];
  let bad = options.invalid ?? 0;
  const usage = { costUsd: options.usd ?? 0.05, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 };
  const runnerFor = (runner: AgentRunnerOptions) => ({
    run: async (input: StepRunInput): Promise<StepRunOutcome> => {
      prompts.push(input.prompt);
      budgets.push(runner.maxBudgetUsd);
      if (bad-- > 0) return { ok: true, output: JSON.stringify({ ...script, chapters: [] }), usage };
      const reply = options.repaired && input.prompt.includes("## Checks the draft fails") ? options.repaired : script;
      return { ok: true, output: `Here is the script.\n\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`\n`, usage };
    },
  });
  return { runnerFor, prompts, budgets };
}

/** The decision brief's two models: the sampling call answers the audition's prompt, `script` the script stage's. */
export function fakeBriefModels(script = fakeScriptModel()): FakeScriptModel & { script: FakeScriptModel } {
  const audition = fakeAuditionModel();
  const runnerFor = (options: AgentRunnerOptions) => {
    const runners = { audition: audition.runnerFor(options), script: script.runnerFor(options) };
    return { run: (input: StepRunInput) => runners[input.stepId as keyof typeof runners].run(input) };
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
      const words = ("text" in input ? input.text : "").split(/\s+/).filter(Boolean);
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

export function fakeHost(fx: Fixture, model: FakeScriptModel, bridge: FakeBridge, extra: Partial<RunHost & Fakes> = {}): RunHost & Fakes {
  const rewriter = extra.rewriter ?? fakeRewriter();
  const rubric = extra.rubric ?? fakeRubricJudge();
  let tick = Date.parse("2026-10-22T00:00:00Z");
  const now = () => new Date((tick += 1000));
  const harnessFor = () => routeRubric(rubric.harness, rewriter.harness);
  return { dataDir: fx.dataDir, runnerFor: model.runnerFor, harnessFor, exec: bridge.exec, ttsEngine: fakeVoice().engine, evalChecks: [l0Check(true)], now, ...extra, rewriter, rubric };
}

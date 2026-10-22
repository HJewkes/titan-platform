import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunnerOptions, StepRunInput, StepRunOutcome } from "@titan-design/workflow";
import type { L0Check } from "../eval-l0.js";
import { choppy, fakeRewriter } from "../rewrite-fixtures.test-helpers.js";
import type { ScriptV1 } from "../script-schema.js";
import { sha256 } from "./artifacts.js";
import type { BridgeExec, BridgeFile, ExecRequest } from "./bridge.js";
import type { RunHost } from "./host.js";

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

export const FACTS = "# Facts\n\n| Id | Claim |\n|---|---|\n| F1 | Every scan passes the desk server. |\n";

export interface Fixture {
  dataDir: string;
  workdir: string;
  theater: string;
  spine: string;
  facts: string;
  cleanup: () => void;
}

const BRIDGE: Omit<BridgeFile, "workdir" | "theater"> & { schema: "explainer-bridge/v1" } = {
  schema: "explainer-bridge/v1",
  stages: {
    tts: {
      inputs: { script: "script.json" },
      outputs: { words: { path: "out/words.json", tree: false }, audio: { path: "out/audio", tree: true } },
      commands: [{ argv: ["node", "tools/tts.mjs", "{in.script}", "{out.audio}"], timeoutS: 60 }],
    },
    render: {
      inputs: { words: "out/words.json", audio: "out/audio" },
      outputs: { mp4: { path: "out/demo.mp4", tree: false }, vtt: { path: "out/demo.vtt", tree: false } },
      commands: [{ argv: ["node", "tools/render.ts", "{out.mp4}"], timeoutS: 60 }],
    },
    qa: { inputs: { mp4: "out/demo.mp4" }, outputs: { qa: { path: "out/qa.json", tree: false } }, commands: [{ argv: ["node", "tools/qa.ts"], timeoutS: 60, check: "qa" }] },
    sheets: { inputs: {}, outputs: { sheet: { path: "out/sheet.png", tree: false } }, commands: [{ argv: ["sh", "tools/sheets.sh"], timeoutS: 60 }] },
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

export interface FakeBridge {
  exec: BridgeExec;
  /** Each command's script name, in order. */
  calls: string[];
  /** sha of the script.json the tts command was handed, per call. */
  ttsInputs: string[];
}

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const at = (req: ExecRequest, rel: string) => path.join(req.cwd, rel);

/** Each template command's stand-in, by script name: it writes what the real one would, derived from its inputs. */
function templateBodies(options: { qaFails?: boolean }, ttsInputs: string[]): Record<string, (req: ExecRequest) => { code: number; stdout: string }> {
  return {
    "tts.mjs": (req) => {
      const script = readFileSync(req.argv[2]!, "utf8");
      ttsInputs.push(sha256(script));
      write(path.join(req.argv[3]!, "b1.wav"), `wav:${sha256(script)}`);
      write(at(req, "out/words.json"), JSON.stringify({ words: sha256(script) }));
      return { code: 0, stdout: "1 beat in 0.1s\n" };
    },
    "render.ts": (req) => {
      write(req.argv[2]!, `mp4:${readFileSync(at(req, "out/words.json"), "utf8")}`);
      write(at(req, "out/demo.vtt"), "WEBVTT\n");
      return { code: 0, stdout: '{"frames":30}\n' };
    },
    "qa.ts": (req) => {
      write(at(req, "out/qa.json"), JSON.stringify({ pass: !options.qaFails }));
      return options.qaFails ? { code: 1, stdout: "qa FAIL demo: 1 held errors\n" } : { code: 0, stdout: "qa PASS demo: 0 held errors, 2 moments\n" };
    },
    "sheets.sh": (req) => {
      write(at(req, "out/sheet.png"), "png");
      return { code: 0, stdout: "" };
    },
  };
}

/** Stands in for the template commands and records which ran. */
export function fakeBridge(options: { qaFails?: boolean } = {}): FakeBridge {
  const calls: string[] = [];
  const ttsInputs: string[] = [];
  const bodies = templateBodies(options, ttsInputs);
  const exec: BridgeExec = async (req) => {
    const name = path.basename(req.argv[1]!);
    calls.push(name);
    const { code, stdout } = bodies[name]!(req);
    return { code, stdout, stderr: code === 0 ? "" : "held errors at b1\n" };
  };
  return { exec, calls, ttsInputs };
}

export interface FakeScriptModel {
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

/** One L0 row, so a test picks the eval stage's verdict without writing a script the whole L0 set passes. */
export const l0Check = (pass: boolean): L0Check => () => [{ check_id: "fake-l0", mode: "tagged", severity: "error", value: pass ? 0 : 1, threshold: 0, pass, detail_beats: [] }];

/** A host on fakes, with a clock that moves one second per read so stage wall times are exact. */
export function fakeHost(fx: Fixture, model: FakeScriptModel, bridge: FakeBridge, extra: Partial<RunHost> = {}): RunHost & { rewriter: ReturnType<typeof fakeRewriter> } {
  const rewriter = fakeRewriter();
  let tick = Date.parse("2026-10-22T00:00:00Z");
  const now = () => new Date((tick += 1000));
  return { dataDir: fx.dataDir, runnerFor: model.runnerFor, harnessFor: () => rewriter.harness, exec: bridge.exec, evalChecks: [l0Check(true)], now, rewriter, ...extra };
}

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoLaterHistory, seedWorkspace } from "../../implement-task/workspace.js";
import type { PreparedJob, TrackPlugin, TrackScore } from "../runner.js";
import { PlanCaseSchema, type PlanCase } from "./cases.js";
import { scorePlan } from "./score.js";

/** Read-only: the planner may look around the base tree and its one commit, never edit it. */
export const PLAN_TOOLS = ["Read", "Grep", "Glob", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(git log:*)", "Bash(git diff:*)"] as const;
const PLAN_TIMEOUT_SECS = 1200;

const SLICES_SHAPE = '{"slices":[{"title":"…","owns":["<file glob>"],"estimate":<points>,"tests":["<test file>: <scenario>"]}]}';

/** Identical across arms; the design's P prompt with the slice block the scorer counts. */
export function planPrompt(planCase: Pick<PlanCase, "title" | "doneWhen">): string {
  return [
    "Plan this task for a team of implementers. The repository is checked out at the commit the task was briefed against. Read what you need; do not edit files. Produce a plan with: goal; approach and key decisions; risks; and PR-sized slices, each with `owns` file globs, an estimate in points, the tests it adds (file, scenario), and the dispatch order (what is sequential, what may run in parallel). Size slices so each is one reviewable PR.",
    `Task: ${planCase.title}\nDone when: ${planCase.doneWhen}`,
    `Finish your answer with one fenced JSON block listing the slices, and nothing after it:\n\`\`\`json\n${SLICES_SHAPE}\n\`\`\``,
  ].join("\n\n");
}

/** Every `cases/*.json` under the case dir, in file-name order, which the builder writes as the queue order. */
export function loadPlanCases(casesDir: string): PlanCase[] {
  const dir = join(casesDir, "cases");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  return files.map((name) => PlanCaseSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
}

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | undefined => (typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : undefined);

function textOf(line: Json): string {
  const content = asObject(line.message)?.content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: unknown) => {
    const entry = asObject(block);
    return entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
  }).join("\n");
}

function parseLine(raw: string): Json | undefined {
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** The final message: the text of the last main-chain assistant message that has any, across its streamed lines. */
export function finalText(transcript: string): string {
  const lines = transcript.split("\n").flatMap((raw): Json[] => {
    const line = parseLine(raw);
    return line?.type === "assistant" && line.isSidechain !== true ? [line] : [];
  });
  const last = [...lines].reverse().find((line) => textOf(line) !== "");
  if (last === undefined) return "";
  const id = asObject(last.message)?.id;
  const same = id === undefined ? [last] : lines.filter((line) => asObject(line.message)?.id === id);
  return same.map(textOf).filter((part) => part !== "").join("\n");
}

interface PlanTrackOptions {
  /** The built case dir: `cases/*.json` and `trees/<id>`. */
  casesDir: string;
  /** The run dir; plans are saved under `<runDir>/plans/` for the judge. */
  runDir: string;
}

const planFileOf = (sessionId: string): string => join("plans", `${sessionId}.md`);

/** The P track: a fresh one-commit repo of the base tree per job, a plan scored on slices and file recall. */
export function planTrack(options: PlanTrackOptions): TrackPlugin<PlanCase> {
  return {
    track: "p",
    prepare: async (planCase, _arm, jobDir): Promise<PreparedJob> => {
      const cwd = join(jobDir, "ws");
      await seedWorkspace(join(options.casesDir, "trees", planCase.id), cwd);
      for (const { mergeSha } of planCase.landed) await assertNoLaterHistory(cwd, mergeSha);
      return { cwd, prompt: planPrompt(planCase), allowedTools: PLAN_TOOLS, timeoutSecs: PLAN_TIMEOUT_SECS, appendSystemPromptFile: join(cwd, "CLAUDE.md") };
    },
    score: (job, planCase): Promise<TrackScore> => {
      const plan = existsSync(job.transcript) ? finalText(readFileSync(job.transcript, "utf8")) : "";
      const planFile = planFileOf(job.sessionId);
      mkdirSync(join(options.runDir, "plans"), { recursive: true });
      writeFileSync(join(options.runDir, planFile), plan);
      const areas = [...planCase.packages, ...planCase.topDirs];
      return Promise.resolve({ result: { ...scorePlan(plan, { slicesLanded: planCase.slicesLanded, areas }), planFile, pool: planCase.pool, kind: planCase.kind } });
    },
    cleanup: (_planCase, _arm, prepared) => {
      rmSync(prepared.cwd, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { localCloneGit } from "../review-pr/bundle.js";
import { planBatches, readItemRows, runBatch, secondJudgeAgreement } from "./judge/batch.js";
import { claudePrintJudge } from "./judge/core.js";
import { loadPlanCases } from "./plan/job.js";
import { planControls, planPairItems, storedPlans } from "./plan/judge.js";
import { buildReference } from "./plan/reference.js";

interface JudgePlanFlags {
  run: string;
  cases: string;
  repo: string;
  out?: string;
  configDir?: string;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** References come from the clone at judge time and live only in memory, never in a run or job dir. */
async function referencesFor(repo: string, cases: ReturnType<typeof loadPlanCases>, wanted: ReadonlySet<string>): Promise<Map<string, string>> {
  const git = localCloneGit(repo);
  const references = new Map<string, string>();
  for (const planCase of cases) if (wanted.has(planCase.id)) references.set(planCase.id, await buildReference(git, planCase.landed));
  return references;
}

async function judgePlan(flags: JudgePlanFlags): Promise<boolean> {
  const configDir = flags.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (configDir === undefined || configDir === "") throw new Error("--config-dir or CLAUDE_CONFIG_DIR names the profile the judge logs in with");
  const runDir = resolve(flags.run);
  const outDir = resolve(flags.out ?? runDir);
  const cwd = join(outDir, "judge-cwd");
  mkdirSync(cwd, { recursive: true });
  const ledgerPath = join(outDir, "judgments.jsonl");
  const cases = loadPlanCases(resolve(flags.cases));
  const plans = storedPlans(readJsonl(join(runDir, "scores.jsonl")), readJsonl(join(runDir, "jobs.jsonl")), { plan: (file) => readFileSync(join(runDir, file), "utf8"), reference: () => "" });
  const references = await referencesFor(resolve(flags.repo), cases, new Set(plans.keys()));
  const source = { plan: (file: string) => readFileSync(join(runDir, file), "utf8"), reference: (caseId: string) => references.get(caseId) ?? "" };
  const done = new Set(readItemRows(ledgerPath).map((row) => row.key));
  const pending = planPairItems(plans, cases, source).filter((entry) => !done.has(entry.item.key));
  const deps = { judge: claudePrintJudge({ configDir, cwd }), ledgerPath };
  let allPassed = true;
  for (const plan of planBatches("p", pending, planControls(plans, cases, source), 2)) {
    const result = await runBatch(plan, deps);
    allPassed &&= result.outcome === "passed";
    console.error(JSON.stringify({ batch: result.batchId, outcome: result.outcome, items: result.items.length }));
  }
  console.error(JSON.stringify({ pending: pending.length, agreement: secondJudgeAgreement(readItemRows(ledgerPath)) }));
  return allPassed;
}

/** Adds `judge-plan`: each P arm's plan against the anchor's on the same case, both orders, under planted controls. */
export function registerJudgePlan(program: Command, onResult: (code: number) => void = (code) => void (process.exitCode = code)): Command {
  const command = new Command("judge-plan")
    .description("Judge each P arm's plan against the anchor (O-med) with the landed reference; appends to <out>/judgments.jsonl and resumes by item key")
    .requiredOption("--run <dir>", "the P run dir holding scores.jsonl, jobs.jsonl and plans/")
    .requiredOption("--cases <dir>", "the P case dir the run used")
    .requiredOption("--repo <clone>", "a local clone holding the landed merges, for the reference")
    .option("--out <dir>", "where judgments.jsonl goes (default: the run dir)")
    .option("--config-dir <dir>", "the claude profile the judge logs in with (default: $CLAUDE_CONFIG_DIR)")
    .exitOverride()
    .action(async (flags: JudgePlanFlags) => {
      try {
        onResult((await judgePlan(flags)) ? 0 : 1);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench judge-plan: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
  return program.addCommand(command);
}

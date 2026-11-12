// `titan-factory shepherd visual-week-feedback` (TP-5409): the week's post-merge visual sheet for one repo, printed, and
// with --file filed into the console with the same titan-console argv visual delivery runs (`shepherd.visualDelivery`).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT, defineCommand } from "@titan-design/registry";
import type { WorkflowStatus } from "@titan-design/workflow";
import { z } from "zod";
import { configPath, factoryStateDir, loadConfig, type FactoryConfig } from "../config.js";
import type { FactoryContext } from "../context.js";
import { RepoArg, coded } from "./register-args.js";
import { SHEPHERD_WORKFLOW } from "./services.js";
import { systemDeliveryExec, type DeliveryExec } from "./visual-delivery.js";
import type { FeedbackRound } from "./visual-feedback-round.js";
import { visualFeedbackWeek, type Filed, type FeedbackWeekResult } from "./visual-feedback-week.js";

const EVERY_STATUS: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];
/** The asker the console records; a sheet is Shepherd's, not a seat's. */
const ASKER_SEAT = "shepherd";
const FiledReport = z.looseObject({ id: z.string().min(1), created: z.boolean() });

const Args = z.object({ repo: RepoArg, week: z.string().optional(), file: z.boolean().optional() });

interface FileVia {
  console: readonly string[];
  dir: string;
  exec: DeliveryExec;
}

/** round.json is written under the factory state dir first, as `decisions file` reads a path; a re-file of the same bytes reports `created: false`. */
export async function fileFeedbackRound(round: FeedbackRound, via: FileVia): Promise<Filed> {
  await mkdir(via.dir, { recursive: true, mode: 0o700 });
  const source = join(via.dir, `${round.unit}.json`);
  await writeFile(source, `${JSON.stringify(round, null, 2)}\n`, { mode: 0o600 });
  try {
    const result = await via.exec([...via.console, "decisions", "file", source, "--seat", ASKER_SEAT, "--json"], AbortSignal.timeout(120_000));
    const report = result.status === 0 ? FiledReport.safeParse(JSON.parse(result.stdout)) : undefined;
    if (report?.success) return { id: report.data.id, created: report.data.created };
    return { failed: `decisions file exit ${result.status}: ${result.stderr.trim().split("\n")[0] ?? ""}` };
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

function filerOf(config: FactoryConfig, env: NodeJS.ProcessEnv): (round: FeedbackRound) => Promise<Filed> {
  const delivery = config.shepherd?.visualDelivery;
  if (delivery === undefined) throw coded("--file needs shepherd.visualDelivery.console, the titan-console argv", EXIT.UNAVAILABLE);
  const via = { console: delivery.console, dir: join(factoryStateDir(env), "visual-feedback"), exec: systemDeliveryExec(delivery.roundsDir) };
  return (round) => fileFeedbackRound(round, via);
}

export const visualFeedbackCommand = defineCommand<z.infer<typeof Args>, FeedbackWeekResult, FactoryContext>({
  name: "shepherd.visual-week-feedback",
  description: "The post-merge visual feedback sheet for owner/repo: its PRs Shepherd merged in an ended ISO week (default the last) with visual paths changed, as one round of kind feedback with no merge-bound question. Off unless shepherd.visualGate is async. With file, it files the round into the console",
  args: Args,
  result: z.custom<FeedbackWeekResult>(),
  run: async ({ repo, week, file }, ctx) => {
    const config = loadConfig(configPath(process.env));
    const runs = () => ctx.host.runtime.listByWorkflow(SHEPHERD_WORKFLOW, EVERY_STATUS);
    const filer = file === true ? (round: FeedbackRound) => filerOf(config, process.env)(round) : undefined;
    return visualFeedbackWeek({ repo, ...(week !== undefined && { week }) }, { shepherd: config.shepherd, runs, now: new Date(), ...(filer && { file: filer }) });
  },
});

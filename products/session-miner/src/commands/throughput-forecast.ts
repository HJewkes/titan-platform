import { defineCommand } from "@titan-design/registry";
import { closureRates, forecastSet, weekEffects, type SetForecast, type TaskForecast } from "@titan-design/throughput";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { FIT_OPTIONS, FitArgs, fitTable, loadRows, renderInputs, type ThroughputInputs } from "./throughput.js";
import { selectSetTasks } from "./throughput-set.js";
import type { UnparsedTask } from "./throughput-rows.js";

const DEFAULT_SEED = "titan-miner";

const ForecastArgs = z
  .object({
    ...FitArgs,
    tasks: z.array(z.string()).optional().describe("task ids to forecast (repeatable or comma list)"),
    parent: z.string().optional().describe("forecast every open descendant of this task"),
    milestone: z.string().optional().describe("forecast the open tasks tagged milestone:<tag>"),
    initiative: z.string().optional().describe("scopes a milestone whose name recurs across initiatives"),
    seed: z.string().optional().describe("simulation seed (default titan-miner)"),
    draws: z.number().int().positive().optional().describe("simulated sets (default 2000)"),
    weekEffect: z.enum(["on", "off"]).optional().describe("apply the shared week multiplier (default on)"),
    closure: z.enum(["on", "off"]).optional().describe("let tasks close with no agent work (default on)"),
  })
  .strict();
type ForecastArgs = z.infer<typeof ForecastArgs>;

type Selector = Parameters<typeof selectSetTasks>[2];

interface ThroughputForecastResult extends ThroughputInputs {
  selector: Selector;
  forecast: SetForecast;
  notFound: string[];
  skippedDone: string[];
  setUnparsed: UnparsedTask[];
}

export const throughputForecast = defineCommand<ForecastArgs, ThroughputForecastResult | string, MinerContext>({
  name: "throughput.forecast",
  description: "Forecast a set of open tasks: total implementer agent-hours, reviewer agent-hours and USD at p10/p50/p80/p90",
  args: ForecastArgs,
  result: z.union([z.custom<ThroughputForecastResult>(), z.string()]),
  cli: {
    options: {
      ...FIT_OPTIONS,
      tasks: { long: "--tasks", description: "task ids (repeatable or comma list)" },
      parent: { long: "--parent", description: "forecast all open descendants of this task" },
      milestone: { long: "--milestone", description: "forecast open tasks tagged milestone:<tag>" },
      initiative: { long: "--initiative", description: "scopes a recurring milestone name" },
      seed: { long: "--seed", description: "simulation seed (default titan-miner)" },
      draws: { long: "--draws", description: "simulated sets (default 2000)" },
      weekEffect: { long: "--week-effect", description: "on or off (default on)" },
      closure: { long: "--closure", description: "on or off (default on)" },
    },
  },
  async run(args, ctx) {
    const selector = toSelector(args);
    const loaded = await loadRows(ctx, args.cap);
    const { table, inputs } = fitTable(loaded, args);
    const { initiativesRoot, throughputInitiatives } = ctx.config;
    const selection = await selectSetTasks(initiativesRoot, throughputInitiatives, selector);
    if (selection.tasks.length === 0) {
      throw new Error(`no open task selected (notFound ${selection.notFound.length}, skippedDone ${selection.skippedDone.length}); searched ${throughputInitiatives.join(",")} (TITAN_MINER_THROUGHPUT_INITIATIVES)`);
    }
    const forecast = forecastSet(selection.tasks, table, {
      seed: args.seed ?? DEFAULT_SEED,
      draws: args.draws,
      closure: args.closure === "off" ? undefined : closureRates(loaded.rows, table),
      weekEffect: args.weekEffect === "off" ? undefined : weekEffects(loaded.rows, table),
    });
    const result = { ...inputs, selector, forecast, notFound: selection.notFound, skippedDone: selection.skippedDone, setUnparsed: selection.unparsed };
    return ctx.format === "human" ? renderForecast(result) : result;
  },
});

function toSelector(args: ForecastArgs): Selector {
  const chosen = [args.tasks, args.parent, args.milestone].filter((value) => value !== undefined).length;
  if (chosen !== 1) throw new Error("pass exactly one of --tasks, --parent or --milestone");
  if (args.initiative !== undefined && args.milestone === undefined) throw new Error("--initiative only scopes --milestone");
  if (args.tasks) return { tasks: args.tasks.flatMap((entry) => entry.split(",")).map((id) => id.trim()).filter(Boolean) };
  if (args.parent !== undefined) return { parent: args.parent };
  return { milestone: args.milestone!, initiative: args.initiative };
}

function renderForecast(result: ThroughputForecastResult): string {
  const { forecast } = result;
  const head = `seed ${forecast.seed}  draws ${forecast.draws}  weekEffect ${forecast.weekEffect}  forecast ${forecast.forecastHash}`;
  const totals = [
    totalLine("impl h", forecast.totals.implAgentHours),
    totalLine("review h", forecast.totals.reviewAgentHours),
    totalLine("usd", forecast.totals.usd),
  ];
  return [renderInputs(result), head, ...totals, ...forecast.tasks.map(taskLine), ...listLines(result)].join("\n");
}

function totalLine(label: string, q: { p10: number; p50: number; p80: number; p90: number }): string {
  return `${label.padEnd(8)} p10 ${q.p10.toFixed(2)} p50 ${q.p50.toFixed(2)} p80 ${q.p80.toFixed(2)} p90 ${q.p90.toFixed(2)}`;
}

function taskLine(task: TaskForecast): string {
  const close = task.closureRate === null ? "n/a" : task.closureRate.toFixed(2);
  return `${task.taskId}  ${task.kind}/${task.band}  from ${task.level}:${task.levelKey}  n ${task.n}  close ${close}`;
}

function listLines(result: ThroughputForecastResult): string[] {
  const lists: [string, string[]][] = [
    ["unclassifiable", result.forecast.unclassifiable.map((task) => task.taskId)],
    ["notFound", result.notFound],
    ["skippedDone", result.skippedDone],
  ];
  return lists.filter(([, ids]) => ids.length > 0).map(([label, ids]) => `${label}: ${ids.join(", ")}`);
}

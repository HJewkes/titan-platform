import { EXIT } from "@titan-design/registry";
import { routeOutcomes, type RouteOutcomeGroup } from "@titan-design/session-analytics";
import { z } from "zod";
import { readShepherdRuns } from "../commands/throughput-review.js";
import { defineInsight, refuseSessionScope } from "./define.js";

const share = z.number().nullable();

export const routeOutcomeSchema = z.object({
  since: z.string().nullable(),
  groups: z.array(
    z.object({
      table: z.string().nullable(),
      mode: z.string().nullable(),
      prior: z.string().nullable(),
      estimateBand: z.enum(["0-1", "2", "3", "4+", "none"]),
      profile: z.string().nullable(),
      source: z.string().nullable(),
      agreement: z.enum(["agree", "differ", "none"]),
      candidateAgreement: z.enum(["agree", "differ", "none"]),
      spawns: z.number().int(),
      prs: z.number().int(),
      mergedPrs: z.number().int(),
      cleanFirstPassPct: share,
      reviewRoundsPerPr: share,
      fixSpawnsPerPr: share,
      implementerUsdPerMergedPr: share,
      allInUsdPerMergedPr: share,
    }),
  ),
}) satisfies z.ZodType<{ since: string | null; groups: RouteOutcomeGroup[] }>;

type RouteOutcomeReport = z.infer<typeof routeOutcomeSchema>;

export const routeOutcomesQuestion = defineInsight<{ shepherdRuns?: string }, RouteOutcomeReport>({
  id: "Q15",
  name: "route-outcomes",
  description: "Per workflow-table version, prior and tier: spawns, clean first pass, review rounds and cost per merged PR",
  options: { shepherdRuns: z.string().min(1).optional().describe("`titan-factory shepherd stats --per-run --json` output; without it review rounds are unknown") },
  flags: { shepherdRuns: { long: "--shepherd-runs", description: "file holding `titan-factory shepherd stats --per-run --json`" } },
  schema: routeOutcomeSchema,
  cliOnly: ["shepherdRuns"],
  answer(db, report, options) {
    refuseSessionScope("route-outcomes", report.scope, "");
    if (report.until !== undefined) throw Object.assign(new Error("route-outcomes does not take until; it reads from --since onward"), { code: EXIT.DATAERR });
    const shepherdRuns = options.shepherdRuns === undefined ? [] : readShepherdRuns(options.shepherdRuns);
    const groups = routeOutcomes(db, { shepherdRuns, since: report.since });
    return { data: { since: report.since ?? null, groups }, text: renderText(groups) };
  },
});

function renderText(groups: readonly RouteOutcomeGroup[]): string {
  if (groups.length === 0) return "no routed spawns in the window";
  const pct = (value: number | null) => (value === null ? "-" : `${value.toFixed(0)}%`);
  return groups
    .map((g) => {
      const head = `${g.table ?? "-"} ${g.prior ?? "-"} band ${g.estimateBand} ${g.profile ?? "-"} ${g.source ?? "-"} ${g.agreement}`;
      return `${head}: ${g.spawns} spawns, ${g.mergedPrs} merged, clean ${pct(g.cleanFirstPassPct)}`;
    })
    .join("\n");
}

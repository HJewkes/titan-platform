import { z } from "zod";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import type { ExplainerFact, FactKind } from "./schemas.js";
import { licenseSafe, type FactOptions } from "./summary-facts.js";

interface HistoryFacts {
  facts: ExplainerFact[];
  diagnostics: GatherDiagnostic[];
}

export const HISTORY_FILE = "structural/graph-report.json";

const Hotspot = z.object({ nodeId: z.string().min(1), churn: z.number(), complexity: z.number(), loc: z.number() });
const BusFactorRisk = z.object({ nodeId: z.string().min(1), busFactor: z.number(), topAuthorShare: z.number(), churn: z.number() });
// Only the fields gather reads; codewatch's `graph report --json` carries many more.
const ReportSchema = z.looseObject({
  snapshot: z.looseObject({ commitHash: z.string().nullable().optional() }),
  windowDays: z.union([z.literal("lifetime"), z.number()]),
  hotspots: z.array(Hotspot).catch([]),
  busFactorRisks: z.array(BusFactorRisk).catch([]),
});
type Report = z.infer<typeof ReportSchema>;

function parseReport(text: string): Report | undefined {
  try {
    const parsed = ReportSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function toFact(kind: FactKind, path: string, text: string, options: FactOptions): ExplainerFact {
  const evidence = [{ path }];
  return {
    id: `history/${kind}/${path}`,
    source: "history",
    kind,
    text,
    evidence,
    tier: "history",
    verified: "yes",
    license_safe: licenseSafe(evidence, options.isLicenseSafe),
  };
}

// A numeric window is counted back from the day the report ran, not from the pin, so only a
// lifetime report at the pin describes the reviewed commit.
function pinProblem(report: Report, pin: string | undefined): string | undefined {
  if (report.windowDays !== "lifetime") return `window is ${report.windowDays} days, not lifetime`;
  if (pin === undefined || report.snapshot.commitHash !== pin) return `snapshot commit ${report.snapshot.commitHash ?? "unknown"} is not the review pin ${pin ?? "unknown"}`;
  return undefined;
}

/**
 * Facts from codewatch's lifetime churn report at the pin: each hotspot a `hotspot` fact, each
 * single-author file a `silo` fact, ids `history/<kind>/<path>`. Any other window or commit yields
 * `W-HISTORY-PIN` and no facts.
 */
export function historyFacts(text: string, pin: string | undefined, options: FactOptions = {}): HistoryFacts {
  const report = parseReport(text);
  if (report === undefined) return { facts: [], diagnostics: [diag("W-BAD-ROW", `${HISTORY_FILE} is not a graph report; skipped`, HISTORY_FILE)] };
  const problem = pinProblem(report, pin);
  if (problem !== undefined) return { facts: [], diagnostics: [diag("W-HISTORY-PIN", `${HISTORY_FILE} ${problem}; no history facts`, HISTORY_FILE)] };
  const hotspots = report.hotspots.map((row) =>
    toFact("hotspot", row.nodeId, `${row.nodeId} changed often and is complex: churn ${row.churn}, complexity ${row.complexity}, ${row.loc} lines`, options),
  );
  const silos = report.busFactorRisks
    .filter((row) => row.busFactor === 1)
    .map((row) => toFact("silo", row.nodeId, `${row.nodeId} has one main author, with ${Math.round(row.topAuthorShare * 100)}% of churn ${row.churn}`, options));
  return { facts: [...hotspots, ...silos], diagnostics: [] };
}

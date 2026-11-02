import { z } from "zod";
import { FACT_NAMES, FACT_SOURCES, ROUTE_SOURCES, type FactsNote, type RouteSource } from "./meta.js";

/**
 * The shadow readout over logged spawn rows: how often the table agrees with what dispatchers asked for, how often it
 * would route down, and how many decisions had the facts to route at all. Pure; the caller reads the rows.
 */

/** One spawn row's meta, as the dispatcher logged it; rows with no `route_source` are ignored. */
export type RouteRow = Readonly<Record<string, unknown>>;

export interface RouteSummary {
  decisions: number;
  bySource: Partial<Record<RouteSource, number>>;
  /** Agreement among decisions the table could have changed; keep-role, override, auto and errors are left out. */
  agreement: { agree: number; of: number };
  /** Shadow decisions whose table pick was the lite tier. */
  wouldLite: number;
  /** Decisions that picked lite with no owns known; the gate to `on` needs this at 0. */
  liteWithoutOwns: number;
  /** Decisions whose facts had both an estimate and owns. */
  factCoverage: { covered: number; of: number };
  /** Decisions where a candidate table was evaluated, and how many picked differently from the live one. */
  candidate: { differs: number; of: number };
}

const COMPARED: readonly RouteSource[] = ["agrees", "shadow", "routed"];

const factsSchema = z.object({
  source: z.enum(FACT_SOURCES),
  present: z.array(z.enum(FACT_NAMES)),
  ambiguous: z.literal(true).optional(),
});

function factsOf(row: RouteRow): FactsNote | undefined {
  const raw = row.route_facts;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = factsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const sourceOf = (row: RouteRow): RouteSource | undefined =>
  ROUTE_SOURCES.find((source) => source === row.route_source);

const isLite = (profile: unknown) => typeof profile === "string" && profile.endsWith("implementer-lite");

interface Decision {
  row: RouteRow;
  source: RouteSource;
  facts: FactsNote | undefined;
}

const share = (of: readonly Decision[], hit: (d: Decision) => boolean) => ({ hits: of.filter(hit).length, of: of.length });

const hasFact = (d: Decision, name: FactsNote["present"][number]) => d.facts?.present.includes(name) === true;

export function summarizeRoutes(rows: readonly RouteRow[]): RouteSummary {
  const decisions = rows.flatMap((row): Decision[] => {
    const source = sourceOf(row);
    return source === undefined ? [] : [{ row, source, facts: factsOf(row) }];
  });
  const bySource: Partial<Record<RouteSource, number>> = {};
  for (const { source } of decisions) bySource[source] = (bySource[source] ?? 0) + 1;
  const agreement = share(
    decisions.filter((d) => COMPARED.includes(d.source)),
    (d) => d.source === "agrees",
  );
  const coverage = share(
    decisions.filter((d) => d.facts !== undefined),
    (d) => hasFact(d, "estimate") && hasFact(d, "owns"),
  );
  const candidate = share(
    decisions.filter((d) => typeof d.row.route_candidate_wanted === "string"),
    (d) => d.row.route_candidate_wanted !== d.row.route_wanted,
  );
  return {
    decisions: decisions.length,
    bySource,
    agreement: { agree: agreement.hits, of: agreement.of },
    wouldLite: decisions.filter((d) => d.source === "shadow" && isLite(d.row.route_wanted)).length,
    liteWithoutOwns: decisions.filter((d) => isLite(d.row.route_wanted) && !hasFact(d, "owns")).length,
    factCoverage: { covered: coverage.hits, of: coverage.of },
    candidate: { differs: candidate.hits, of: candidate.of },
  };
}

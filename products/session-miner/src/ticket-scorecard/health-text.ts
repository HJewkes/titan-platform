import type { FactoryHealth } from "@titan-design/session-analytics";

const NOT_MEASURED = "not measured";

const num = (value: number | null): string => (value === null ? NOT_MEASURED : String(value));
const pct = (value: number | null): string => (value === null ? NOT_MEASURED : `${Math.round(value * 100)}%`);

function selfGeneratedLine({ selfGenerated: g }: FactoryHealth): string {
  const filed = `${g.agentFiled} agent-filed (${g.agentFiledInferred} inferred, ${g.unlabelled} unlabelled)`;
  return `    self-generated: ${filed}; per closed task ${num(g.perClosed)} (${g.closed} closed); per merged PR ${num(g.perMergedPr)} (${g.mergedPrs} merged)`;
}

function fenceLine({ fenceStops: f }: FactoryHealth): string {
  return `    per 100 dispatched (${f.dispatched}): spawn refusals ${num(f.refusalsPer100)} (${f.spawnRefusals}), gate holds ${num(f.holdsPer100)} (${f.gateHolds}), guard denials ${NOT_MEASURED}`;
}

function tierLine({ modelTiers }: FactoryHealth): string {
  const tiers = modelTiers.map((t) => `${t.model} ${t.dispatched} dispatched, ${pct(t.mergeRate)} merged, ${num(t.fixRoundsMean)} fix rounds`);
  return `    model tiers: ${tiers.join("; ") || "none dispatched"}`;
}

function wakeLine({ wakes }: FactoryHealth): string {
  if (wakes === null) return `    seat wakes: ${NOT_MEASURED} (the graph's turns carry no wake cause)`;
  const seats = wakes.map((w) => `${w.seat} ${w.timer}/${w.event}/${w.typed}`);
  return `    seat wakes timer/event/typed: ${seats.join("; ") || "none"}; timer wakes with no action ${NOT_MEASURED}`;
}

/** The "Factory health" group of one week, as the run prints it; every absent figure reads as not measured. */
export function factoryHealthLines(week: FactoryHealth): string[] {
  const c = week.covered;
  return [
    `  factory health ${week.isoWeek}:`,
    `    covered: upkeep share ${pct(c.upkeepShare)}, review rounds median ${num(c.reviewRoundsMedian)}, merged ${c.merged}, spend $${c.usd}`,
    selfGeneratedLine(week),
    fenceLine(week),
    `    factory to product code size: ${NOT_MEASURED} (no factory and product path split to count by)`,
    tierLine(week),
    wakeLine(week),
  ];
}

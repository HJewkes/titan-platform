import type { FactoryHealth } from "@titan-design/session-analytics";

const NOT_MEASURED = "not measured";

const num = (value: number | null): string => (value === null ? NOT_MEASURED : String(value));
const pct = (value: number | null): string => (value === null ? NOT_MEASURED : `${Math.round(value * 100)}%`);

function wakesText(wakes: FactoryHealth["wakes"]): string {
  if (wakes === null) return `seat wakes ${NOT_MEASURED}`;
  const sum = (pick: (w: NonNullable<FactoryHealth["wakes"]>[number]) => number) => wakes.reduce((acc, w) => acc + pick(w), 0);
  return `seat wakes ${sum((w) => w.timer)} timer, ${sum((w) => w.event)} event, no-action share ${NOT_MEASURED}`;
}

/** The weekly slot's one line on the "Factory health" group; a week frozen before the group says so. */
export function factoryHealthLine(health: FactoryHealth | null): string {
  if (health === null) return `Factory health: ${NOT_MEASURED} (week frozen before the group existed).`;
  const g = health.selfGenerated;
  const f = health.fenceStops;
  const inferred = g.agentFiledInferred > 0 ? " (inferred labels)" : "";
  const tiers = health.modelTiers.map((t) => `${t.model} ${pct(t.mergeRate)}`).join(", ") || "none";
  return [
    `Factory health: agent-filed per closed task ${num(g.perClosed)}, per merged PR ${num(g.perMergedPr)}${inferred}`,
    `per 100 dispatched ${num(f.refusalsPer100)} refused, ${num(f.holdsPer100)} held, guard denials ${NOT_MEASURED}`,
    `code size ${NOT_MEASURED}`,
    `merge rate by model ${tiers}`,
    `${wakesText(health.wakes)}.`,
  ].join("; ");
}

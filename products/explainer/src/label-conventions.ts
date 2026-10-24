/** The slice of a script the check reads, which a script/v1 draft satisfies. */
interface Beat {
  id: string;
  chapter: string;
  visual: { beat?: string | undefined; labels: readonly string[] };
}
interface Draft {
  profile?: string | undefined;
  beats: readonly Beat[];
}

const LANE_ROW = / · \S/;
const BEFORE = /^before:\s*\S/i;
const AFTER = /^after:\s*\S/i;
const NAMED_NUMBER = /^[^:]+:\s*-?\d/;

/** What a beat's labels must look like for the daily bridge's view to fire; undefined when the beat has no convention. */
function fault(beat: Beat): string | undefined {
  const { labels } = beat.visual;
  switch (beat.visual.beat) {
    case "list":
      return labels.every((label) => LANE_ROW.test(label)) ? undefined : `${beat.id} (list) has a row without a "<lane> · <text>" lane chip`;
    case "compare":
      return labels.some((label) => BEFORE.test(label)) && labels.some((label) => AFTER.test(label)) ? undefined : `${beat.id} (compare) lacks a "before: …" label, an "after: …" label, or both`;
    case "arch-map":
      return labels.length >= 2 && labels.length <= 5 ? undefined : `${beat.id} (arch-map) has ${labels.length} labels, not 2-5 package or stage names`;
    case "chart":
      return labels.filter((label) => NAMED_NUMBER.test(label)).length >= 3 ? undefined : `${beat.id} (chart) has fewer than 3 "name: number" labels`;
    default:
      return undefined;
  }
}

const CONVENTION_CHAPTERS = new Set(["lanes", "ships", "stats"]);
export const LABEL_HINT = 'Rewrite those beats\' "visual.labels": a list row is "<lane> · <text>"; a compare has "before: …" and "after: …"; an arch-map has 2-5 names in flow order; a chart has 3+ "name: number" labels.';

/** The daily's lanes, ships and stats beats whose labels miss the convention their view needs, each with the repair hint. */
export function labelConventionFaults(script: Draft): string[] {
  if (script.profile !== "daily-overview") return [];
  const faults = script.beats.filter((beat) => CONVENTION_CHAPTERS.has(beat.chapter)).flatMap((beat) => fault(beat) ?? []);
  return faults.length > 0 ? [...faults, LABEL_HINT] : [];
}

export const labelConventionsVerdict = (script: Draft): { pass: boolean; detail: string } => {
  const faults = labelConventionFaults(script);
  return { pass: faults.length === 0, detail: faults.length === 0 ? "every lanes, ships and stats beat's labels follow its view's convention" : faults.join("; ") };
};

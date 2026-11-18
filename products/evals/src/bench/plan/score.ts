import { z } from "zod";

export interface PlanSlice {
  title: string;
  owns: string[];
  estimate: unknown;
  tests: unknown;
}

const asList = (value: string | string[]): string[] => (typeof value === "string" ? [value] : value);

const SliceSchema = z.looseObject({
  title: z.string().min(1),
  owns: z.union([z.string(), z.array(z.string())]).transform(asList),
  estimate: z.unknown().optional(),
  tests: z.unknown().optional(),
});
const PlanJsonSchema = z.looseObject({ slices: z.array(SliceSchema).min(1) });

const FENCE = /^```([A-Za-z]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;

/** The plan's last fenced JSON block; null when there is none or it is not a slice list, which is a parse failure. */
export function parsePlanSlices(text: string): PlanSlice[] | null {
  const blocks = [...text.matchAll(FENCE)].filter(([, lang]) => lang === "" || lang?.toLowerCase() === "json");
  const body = blocks.at(-1)?.[2];
  if (body === undefined) return null;
  try {
    const parsed = PlanJsonSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.slices.map((slice) => ({ title: slice.title, owns: slice.owns, estimate: slice.estimate, tests: slice.tests })) : null;
  } catch {
    return null;
  }
}

const WILDCARD = /[*?[{]/;

/** The directory part of a glob before its first wildcard segment; `""` when the glob starts with one. */
function literalPrefix(glob: string): string {
  const segments = glob.trim().replace(/^\.\//, "").replace(/^\/+/, "").split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (segment === "" || WILDCARD.test(segment)) break;
    literal.push(segment);
  }
  return literal.join("/");
}

/** A glob covers an area when the files it names can lie inside it, or when it names the whole area or a parent of it. */
export function globCoversArea(glob: string, area: string): boolean {
  const prefix = literalPrefix(glob);
  return prefix === "" || prefix === area || prefix.startsWith(`${area}/`) || area.startsWith(`${prefix}/`);
}

/** Share of the landed areas (packages and top-level dirs) that some `owns` glob covers. */
export function fileRecall(owns: readonly string[], areas: readonly string[]): number | null {
  if (areas.length === 0) return null;
  const matched = areas.filter((area) => owns.some((glob) => globCoversArea(glob, area)));
  return matched.length / areas.length;
}

interface LandedTruth {
  slicesLanded: number;
  areas: readonly string[];
}

type PlanScore =
  | { parse: "ok"; slicesPlanned: number; slicesLanded: number; sliceError: number; fileRecall: number | null }
  | { parse: "parse-fail"; slicesPlanned: null; slicesLanded: number; sliceError: null; fileRecall: null };

/** Slice-count error is signed, planned minus landed, so over- and under-splitting stay apart in the means. */
export function scorePlan(text: string, truth: LandedTruth): PlanScore {
  const slices = parsePlanSlices(text);
  if (slices === null) return { parse: "parse-fail", slicesPlanned: null, slicesLanded: truth.slicesLanded, sliceError: null, fileRecall: null };
  const owns = slices.flatMap((slice) => slice.owns);
  return { parse: "ok", slicesPlanned: slices.length, slicesLanded: truth.slicesLanded, sliceError: slices.length - truth.slicesLanded, fileRecall: fileRecall(owns, truth.areas) };
}

import { isAbsolute, resolve } from "node:path";
import { PEER_NAME_PATTERN } from "@titan-design/agent-dispatch";
import { isRepo } from "@titan-design/github";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Lowercase so the agent name is legal; its length is checked against the whole name in `assertAgentNames`. A leading letter keeps `deploy-approve:<slice>` from reading as the
 * `:<n>` repeat of a gate.
 */
const SLICE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const Argv = z.array(z.string().min(1)).min(1);

const SliceSchema = z.object({
  id: z.string().regex(SLICE_ID, "a slice id is a lowercase letter, then lowercase letters, digits and dashes"),
  title: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  /** What the implementer builds, as the brief's body; the workflow adds the report contract. */
  brief: z.string().min(1),
  /** Path prefixes the diff must stay inside; checked by the repo's report validator, which gets them on stdin. */
  partition: z.array(z.string().min(1)).default([]),
  /** The branch the implementer pushes to; defaults to `build-surface/<id>`. */
  branch: z.string().min(1).optional(),
  /** The active-work task the slice's PR delivers; defaults to the spec's `task`. */
  task: z.string().min(1).optional(),
  /**
   * Per-slice switches for the spec's `preview` and `deploy`. Absent inherits the spec; `false` skips that step for this slice and the
   * slice's outcome records it as skipped. `true` only matters where the spec enables the step: a slice cannot turn on a step the spec
   * leaves out, so it is the same as absent there.
   */
  preview: z.boolean().optional(),
  deploy: z.boolean().optional(),
  /** A one-turn target extraction before the implementer starts; its answer goes into the brief. */
  extract: z.object({ prompt: z.string().min(1), model: z.string().min(1).default("opus"), maxBudgetUsd: z.number().positive().default(2) }).optional(),
});

/**
 * `titan.build-surface/v1`: everything repo-specific about a build, so the workflow names no repo, gate or path. Each
 * command is an argv run in `clone`; a validator reads the agent's JSON on stdin and exits non-zero with one rejection
 * per stdout line.
 */
export const BuildSpecSchema = z.object({
  schema: z.literal("titan.build-surface/v1"),
  repo: z.string().refine(isRepo, "must be owner/repo"),
  clone: z.string().refine(isAbsolute, "must be an absolute path"),
  base: z.string().min(1).default("main"),
  task: z.string().min(1),
  gate: z.object({
    command: Argv,
    /** Where the gate command writes one `<gate>.json` per gate; `{slice}` and `{head}` are filled in. */
    evidence: z.string().min(1),
  }),
  preview: z.object({ command: Argv, deviceStep: z.string().min(1).max(280).optional() }).optional(),
  deploy: z.object({ command: Argv, approve: z.boolean().default(true) }).optional(),
  preflight: z.object({ command: Argv }).optional(),
  validate: z.object({ targets: Argv.optional(), report: Argv.optional(), review: Argv.optional() }).default({}),
  implementer: z.object({ profile: z.string().min(1).default("bd-implementer") }).default({ profile: "bd-implementer" }),
  /** The reviewer's read-only profile; absent means no review step, so the gates alone decide. */
  reviewer: z.object({ profile: z.string().min(1) }).optional(),
  budgetUsd: z.number().positive(),
  sliceBudgetUsd: z.number().positive(),
  maxFixRounds: z.number().int().min(0).default(12),
  /** Rounds one gate may fail without its score improving before the slice stops. */
  noImprovementRounds: z.number().int().min(1).default(3),
  concurrency: z.number().int().min(1).max(3).default(3),
  slices: z.array(SliceSchema).min(1),
});

export type BuildSpec = z.infer<typeof BuildSpecSchema>;
export type Slice = z.infer<typeof SliceSchema>;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The spec is the YAML front matter of a markdown file, so the repo's build spec stays one readable document. */
export function parseBuildSpec(text: string): BuildSpec {
  const front = FRONT_MATTER.exec(text)?.[1];
  if (front === undefined) throw new Error("build spec: no YAML front matter");
  const parsed = BuildSpecSchema.safeParse(parse(front));
  if (!parsed.success) throw new Error(`build spec: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  assertSliceGraph(parsed.data.slices);
  assertAgentNames(parsed.data);
  return parsed.data;
}

/** The longest name a slice's agents take is its last round's reviewer, so a long id fails here, not after the implementer's work. */
function assertAgentNames(spec: BuildSpec): void {
  for (const slice of spec.slices) {
    const longest = spec.reviewer ? reviewerNameOf(spec, slice, spec.maxFixRounds) : agentNameOf(spec, slice);
    if (!PEER_NAME_PATTERN.test(longest)) throw new Error(`build spec: slice "${slice.id}" gives the agent name "${longest}", over agent-chat's 64 characters; shorten the id`);
  }
}

/** Unknown, duplicate or circular dependencies would leave a slice that no wave ever picks up. */
function assertSliceGraph(slices: readonly Slice[]): void {
  const ids = new Set<string>();
  for (const slice of slices) {
    if (ids.has(slice.id)) throw new Error(`build spec: slice "${slice.id}" is declared twice`);
    ids.add(slice.id);
  }
  for (const slice of slices) {
    const unknown = slice.dependsOn.find((dep) => !ids.has(dep));
    if (unknown) throw new Error(`build spec: slice "${slice.id}" depends on unknown slice "${unknown}"`);
  }
  const done = new Set<string>();
  for (let wave = readySlices(slices, done, new Set()); wave.length > 0; wave = readySlices(slices, done, new Set())) wave.forEach((slice) => done.add(slice.id));
  const stuck = slices.find((slice) => !done.has(slice.id));
  if (stuck) throw new Error(`build spec: slice "${stuck.id}" is on a dependency cycle`);
}

/** Slices not yet finished or stopped whose every dependency has merged. */
export function readySlices(slices: readonly Slice[], merged: ReadonlySet<string>, ended: ReadonlySet<string>): Slice[] {
  return slices.filter((slice) => !merged.has(slice.id) && !ended.has(slice.id) && slice.dependsOn.every((dep) => merged.has(dep)));
}

export const branchOf = (slice: Slice): string => slice.branch ?? `build-surface/${slice.id}`;
/** Agent names are machine-wide, so the repo's name keeps two builds' slices of the same id apart. */
export function agentNameOf(spec: BuildSpec, slice: Slice): string {
  const repo = spec.repo.split("/")[1]!.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 20);
  return `bs-${repo}-${slice.id}`.replace(/-+/g, "-");
}
export const reviewerNameOf = (spec: BuildSpec, slice: Slice, round: number): string => `${agentNameOf(spec, slice)}-rv${round}`;
/** The gate command's evidence directory for one head, under the clone unless the spec gives an absolute path. */
export function evidenceDirOf(spec: BuildSpec, slice: string, head: string): string {
  return resolve(spec.clone, spec.gate.evidence.replaceAll("{slice}", slice).replaceAll("{head}", head));
}

/** Whether the spec's preview or deploy step runs for this slice: the spec must enable it and the slice must not switch it off. */
export const STEPS = ["preview", "deploy"] as const;
export const runsStep = (spec: BuildSpec, slice: Slice, step: (typeof STEPS)[number]): boolean => spec[step] !== undefined && slice[step] !== false;

/** The steps the spec enables that this slice switched off, so a report tells a skip from a step the spec never had. */
export const skippedSteps = (spec: BuildSpec, slice: Slice): (typeof STEPS)[number][] => STEPS.filter((step) => spec[step] !== undefined && !runsStep(spec, slice, step));

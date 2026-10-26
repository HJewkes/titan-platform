import { z } from "zod";
import { BEAT_FUNCTIONS } from "./script-schema.js";

const Kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a kebab-case name");
const Seconds = z.number().int().nonnegative();

/**
 * When a structure fits one video's material (plan §A.3): every `all` signal holds, at least one
 * `any` signal holds when `any` lists some, no `none` signal holds, and the runtime is in bounds.
 * `ask` is the story-structure §4 question the predicate encodes.
 */
const FitSchema = z
  .object({
    ask: z.string().min(1),
    all: z.array(Kebab).default([]),
    any: z.array(Kebab).default([]),
    none: z.array(Kebab).default([]),
    minRuntimeS: Seconds.optional(),
    maxRuntimeS: Seconds.optional(),
  })
  .strict()
  .refine((fit) => fit.all.length + fit.any.length > 0, "a fit predicate names at least one signal in all or any");

/** `maxItems` is the block's own cap on parallel items (countdown: at most five); the audition checks it, the goal text only says it. */
const StructureBlockSchema = z.object({ id: Kebab, goal: z.string().min(1), share: z.number().gt(0).max(1), maxItems: z.number().int().positive().optional() }).strict();

/** One section of the structure's story spine: the planner fills it before it writes beats. */
const SpineSectionSchema = z.object({ title: z.string().min(1), body: z.string().min(1) }).strict();

/**
 * One narrative structure (plan §A.2): the macro shape a profile's video may take. A human writes
 * it; the agent picks one per video (owner Q1 A) and records the runner-up in the render notes.
 */
export const NarrativeStructureSchema = z
  .object({
    schema: z.literal("narrative-structure/v1"),
    id: Kebab,
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "expected a semver version"),
    source: z.string().min(1),
    summary: z.string().min(1),
    fit: FitSchema,
    blocks: z.array(StructureBlockSchema).min(2),
    hook: z.string().min(1),
    ending: z.string().min(1),
    spine: z.array(SpineSectionSchema).min(1),
    /** The beat functions that may voice the stake for Q-W1; absent means STAKE alone. scqa's bottom line comes first and carries it. */
    stakeFunctions: z.array(z.enum(BEAT_FUNCTIONS)).min(1).optional(),
  })
  .strict();

export type NarrativeStructure = z.infer<typeof NarrativeStructureSchema>;
export type StructureFit = NarrativeStructure["fit"];

/** The material map's signals for one video, and its planned runtime. */
export interface FitInput {
  signals: ReadonlySet<string>;
  runtimeS: number;
}

/** Whether a structure's fit predicate holds for one video's material. */
export function fits({ fit }: NarrativeStructure, { signals, runtimeS }: FitInput): boolean {
  const holds = (signal: string): boolean => signals.has(signal);
  const signalsHold = fit.all.every(holds) && (fit.any.length === 0 || fit.any.some(holds)) && !fit.none.some(holds);
  return signalsHold && runtimeS >= (fit.minRuntimeS ?? 0) && runtimeS <= (fit.maxRuntimeS ?? Number.POSITIVE_INFINITY);
}

/** The structure's spine as the markdown template a planner fills: a title line, then numbered sections. */
export function renderSpine({ spine }: NarrativeStructure): string {
  const sections = spine.map(({ title, body }, i) => `## ${i + 1}. ${title}\n${body.trimEnd()}`);
  return ["# Story spine: <video id>", ...sections].join("\n\n");
}

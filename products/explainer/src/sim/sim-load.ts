import { z } from "zod";
import { DEFAULT_DOCTRINE_DIR } from "../doctrine-load.js";
import { readYamlDir } from "../yaml-dir.js";
import { canonicalSha256 } from "./freeze.js";
import type { SimModel } from "./model.js";
import { runPure } from "./pure-run.js";

const SimParamSchema = z
  .strictObject({ default: z.number(), min: z.number(), max: z.number(), unit: z.string().min(1).optional() })
  .refine((param) => param.min <= param.default && param.default <= param.max, "default lies outside [min, max]");

const ToleranceSchema = z.union([z.strictObject({ abs: z.number().positive() }), z.strictObject({ rel: z.number().positive() })]);

const SimStatisticSchema = z.strictObject({
  tolerance: ToleranceSchema,
  why: z.string().min(1),
  unit: z.string().min(1).optional(),
});

/** One `doctrine/sims/<id>.yaml`: a model's params, the statistics a claim may name, and what calibrated it. */
export const SimModelSpecSchema = z
  .strictObject({
    schema: z.literal("sim-model/v1"),
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a kebab-case id"),
    summary: z.string().min(1),
    params: z.record(z.string().min(1), SimParamSchema),
    statistics: z.record(z.string().min(1), SimStatisticSchema).refine((stats) => Object.keys(stats).length > 0, "declare at least one statistic"),
    fittedFrom: z.array(z.string().min(1)).default([]),
  })
  .superRefine((spec, ctx) => {
    for (const name of spec.fittedFrom.filter((stat) => !(stat in spec.statistics))) {
      ctx.addIssue({ code: "custom", path: ["fittedFrom"], message: `fittedFrom names ${name}, which is not a declared statistic` });
    }
  });

export type SimModelSpec = z.infer<typeof SimModelSpecSchema>;
export type SimTolerance = z.infer<typeof ToleranceSchema>;

/** Reads every `sims/<id>.yaml` under `dir`: the sim-model registry. A shape error throws naming the file. */
export function loadSims(dir: string = DEFAULT_DOCTRINE_DIR): Map<string, SimModelSpec> {
  return readYamlDir(dir, "sims", SimModelSpecSchema, (spec) => spec.id);
}

/** The sha a trace records as `doctrine`, so a tolerance change gives a different trace key. */
export const simDoctrineSha = (spec: SimModelSpec): string => canonicalSha256(spec);

export const SIM_ISSUE_CODES = ["E-SIM-NO-DOCTRINE", "E-SIM-NO-MODEL", "E-SIM-STAT-UNEMITTED"] as const;
export type SimIssueCode = (typeof SIM_ISSUE_CODES)[number];
export interface SimIssue {
  code: SimIssueCode;
  model: string;
  message: string;
}

const defaultsOf = (spec: SimModelSpec): Record<string, number> => Object.fromEntries(Object.entries(spec.params).map(([name, param]) => [name, param.default]));

function unemitted(model: SimModel, spec: SimModelSpec): SimIssue[] {
  const emitted = runPure(model, defaultsOf(spec), `check:${spec.id}`).stats;
  return Object.keys(spec.statistics)
    .filter((stat) => !(stat in emitted))
    .map((stat) => ({ code: "E-SIM-STAT-UNEMITTED", model: spec.id, message: `doctrine statistic ${stat} is not one the model emits at its default params` }));
}

/**
 * Every drift between the code registry and the doctrine registry: a model with no doctrine file,
 * a doctrine file with no model, and a doctrine statistic the model never emits.
 */
export function checkSims(models: Readonly<Record<string, SimModel>>, specs: ReadonlyMap<string, SimModelSpec>): SimIssue[] {
  const noDoctrine = Object.keys(models)
    .filter((id) => !specs.has(id))
    .map((id): SimIssue => ({ code: "E-SIM-NO-DOCTRINE", model: id, message: `model ${id} has no doctrine/sims/${id}.yaml` }));
  const checked = [...specs.values()].flatMap((spec): SimIssue[] => {
    const model = models[spec.id];
    if (!model) return [{ code: "E-SIM-NO-MODEL", model: spec.id, message: `doctrine/sims/${spec.id}.yaml has no model in SIM_MODELS` }];
    return unemitted(model, spec);
  });
  return [...noDoctrine, ...checked];
}

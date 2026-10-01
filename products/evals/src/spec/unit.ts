import { z } from "zod";
import { count, fraction, jsonSchema, nonempty, objectFor, semver, specId, visibility } from "./common.js";
import type { SpecParseMode } from "./common.js";

export const UNIT_SCHEMA_VERSION = "titan.unit/v1";
export const ACCEPTANCE_LEVELS = [1, 2, 3, 4] as const;

function objectiveSchema(mode: SpecParseMode) {
  const object = objectFor(mode);
  const bound = object({ metric: nonempty, min: z.number().optional(), max: z.number().optional() })
    .refine((value) => value.min !== undefined || value.max !== undefined, "a constraint needs min or max");
  return object({
    constraints: z.array(bound),
    noCriticalFailures: z.boolean(),
    primary: object({ name: nonempty, direction: z.enum(["maximize", "minimize"]) }),
  });
}

function acceptanceSchema(mode: SpecParseMode) {
  const object = objectFor(mode);
  const rung = object({
    level: z.union(ACCEPTANCE_LEVELS.map((level) => z.literal(level))),
    minCases: count.optional(),
    successLowerBound: fraction.optional(),
    passAllKFloor: fraction.optional(),
    holdDays: count.optional(),
  });
  return object({ levels: z.array(rung) });
}

export function unitSchema(mode: SpecParseMode) {
  const object = objectFor(mode);
  return object({
    schema: z.literal(UNIT_SCHEMA_VERSION),
    id: specId,
    version: semver,
    title: nonempty,
    description: nonempty,
    input: jsonSchema,
    output: jsonSchema,
    artifacts: z.array(object({ name: nonempty, required: z.boolean() })).optional(),
    objective: objectiveSchema(mode),
    acceptance: acceptanceSchema(mode),
    children: z.array(object({ id: specId, version: semver, prefix: nonempty })).optional(),
    visibility,
  });
}

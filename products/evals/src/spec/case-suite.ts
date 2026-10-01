import { z } from "zod";
import { count, modelId, nonempty, objectFor, promptRef, relativePath, sha256, specId, semver, unitRef, visibility } from "./common.js";
import type { SpecParseMode } from "./common.js";
import { checkSchema } from "./check.js";

export const CASE_SCHEMA_VERSION = "titan.case/v1";
export const SUITE_SCHEMA_VERSION = "titan.suite/v1";
export const CASE_SPLITS = ["dev", "validation", "holdout"] as const;

function fixtureRef(mode: SpecParseMode) {
  const object = objectFor(mode);
  return z.discriminatedUnion("kind", [
    object({ kind: z.literal("repo"), repo: nonempty, sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    object({ kind: z.literal("bundle"), path: relativePath, sha256 }),
    object({ kind: z.literal("tree"), path: relativePath, treeSha256: sha256 }),
  ]);
}

export function caseSchema(mode: SpecParseMode) {
  const object = objectFor(mode);
  return object({
    schema: z.literal(CASE_SCHEMA_VERSION),
    id: specId,
    unit: unitRef(mode),
    input: z.unknown().refine((value) => value !== undefined, "input is required"),
    fixture: fixtureRef(mode).optional(),
    expected: z.unknown().optional(),
    owner: z.record(z.string(), z.unknown()).optional(),
    split: z.enum(CASE_SPLITS),
    tags: z.array(nonempty),
    humanMinutes: z.number().nonnegative().optional(),
    provenance: object({
      source: z.enum(["synthetic", "history", "contributed"]),
      ref: nonempty.optional(),
      labelVersion: count.optional(),
    }),
    solvable: object({ by: z.enum(["reference-output", "variant"]), ref: nonempty }).optional(),
    visibility,
  });
}

function simulatedOwner(mode: SpecParseMode) {
  const object = objectFor(mode);
  return z.discriminatedUnion("kind", [
    object({ kind: z.literal("scripted"), answers: z.record(nonempty, z.unknown()) }),
    object({ kind: z.literal("persona"), model: modelId(mode), prompt: promptRef(mode) }),
  ]);
}

export function suiteSchema(mode: SpecParseMode) {
  return objectFor(mode)({
    schema: z.literal(SUITE_SCHEMA_VERSION),
    unit: unitRef(mode),
    id: specId,
    version: semver,
    cases: z.array(sha256),
    checks: z.array(checkSchema(mode)),
    trials: z.number().int().positive().default(3),
    simulatedOwner: simulatedOwner(mode).optional(),
  });
}

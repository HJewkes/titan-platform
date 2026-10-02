import type { z } from "zod";
import type { SpecParseMode } from "./common.js";
import { CASE_SCHEMA_VERSION, SUITE_SCHEMA_VERSION, caseSchema, suiteSchema } from "./case-suite.js";
import { checkSchema } from "./check.js";
import { SCORECARD_SCHEMA_VERSION, scorecardSchema } from "./scorecard.js";
import { trialSchema } from "./trial.js";
import { UNIT_SCHEMA_VERSION, unitSchema } from "./unit.js";
import { VARIANT_SCHEMA_VERSION, variantSchema } from "./variant.js";

function buildSpecSchemas(mode: SpecParseMode) {
  return {
    [UNIT_SCHEMA_VERSION]: unitSchema(mode),
    [VARIANT_SCHEMA_VERSION]: variantSchema(mode),
    [CASE_SCHEMA_VERSION]: caseSchema(mode),
    [SUITE_SCHEMA_VERSION]: suiteSchema(mode),
    [SCORECARD_SCHEMA_VERSION]: scorecardSchema(mode),
  } as const;
}

const strict = buildSpecSchemas("strict");
const loose = buildSpecSchemas("loose");

/** Producer schemas: unknown keys are rejected and model aliases are refused. */
export const UnitSpecSchema = strict[UNIT_SCHEMA_VERSION];
export const VariantSpecSchema = strict[VARIANT_SCHEMA_VERSION];
export const EvalCaseSchema = strict[CASE_SCHEMA_VERSION];
export const SuiteSpecSchema = strict[SUITE_SCHEMA_VERSION];
export const ScorecardSchema = strict[SCORECARD_SCHEMA_VERSION];
export const CheckSpecSchema = checkSchema("strict");

export type UnitSpec = z.infer<typeof UnitSpecSchema>;
export type VariantSpec = z.infer<typeof VariantSpecSchema>;
export type StepSpec = VariantSpec["steps"][string];
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type SuiteSpec = z.infer<typeof SuiteSpecSchema>;
export type CheckSpec = z.infer<typeof CheckSpecSchema>;
export type Scorecard = z.infer<typeof ScorecardSchema>;

/** A trial record is run output, not a hashed spec, so it parses on its own and loose by default. */
export const TrialRecordSchema = trialSchema("strict");
const looseTrialRecord = trialSchema("loose");
export type TrialRecord = z.infer<typeof TrialRecordSchema>;

export function parseTrialRecord(value: unknown, mode: SpecParseMode = "loose"): TrialRecord {
  return (mode === "strict" ? TrialRecordSchema : looseTrialRecord).parse(value);
}

export type SpecSchemaVersion = keyof typeof strict;
export const SPEC_SCHEMA_VERSIONS = Object.keys(strict) as SpecSchemaVersion[];

export type Spec =
  | UnitSpec
  | VariantSpec
  | EvalCase
  | SuiteSpec
  | Scorecard;

/** Parses any spec by its `schema` field; strict on write, loose on read. */
export function parseSpec(value: unknown, mode: SpecParseMode = "strict"): Spec {
  const version = schemaVersionOf(value);
  const schemas = mode === "strict" ? strict : loose;
  return schemas[version].parse(value) as Spec;
}

function schemaVersionOf(value: unknown): SpecSchemaVersion {
  const version = value !== null && typeof value === "object" ? (value as { schema?: unknown }).schema : undefined;
  if (typeof version === "string" && (SPEC_SCHEMA_VERSIONS as string[]).includes(version)) return version as SpecSchemaVersion;
  throw new Error(`unknown spec schema: ${JSON.stringify(version)}; expected one of ${SPEC_SCHEMA_VERSIONS.join(", ")}`);
}

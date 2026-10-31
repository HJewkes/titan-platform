import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { partialFake } from "@titan-design/test-kit";
import type { z } from "zod";
import { EvalCaseSchema, ScorecardSchema, SuiteSpecSchema, UnitSpecSchema, VariantSpecSchema } from "./spec/index.js";
import type { VariantSpec } from "./spec/index.js";

/** The synthetic `summarize-note` unit shipped under fixtures/. */
export const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/summarize-note/", import.meta.url));

export function readFixture(relative: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURE_ROOT}${relative}`, "utf8"));
}

/** Narrows a parsed JSON value to a plain object, so a test can spread it and read its members as `unknown`. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  return Object.fromEntries(Object.entries(value));
}

export function readFixtureObject(relative: string): Record<string, unknown> {
  return asRecord(readFixture(relative));
}

function readAs<S extends z.ZodType>(schema: S, relative: string): z.infer<S> {
  return schema.parse(readFixture(relative));
}

export const readUnit = () => readAs(UnitSpecSchema, "unit.json");
export const readVariant = () => readAs(VariantSpecSchema, "variants/single-pass.json");
export const readSuite = () => readAs(SuiteSpecSchema, "suite.json");
export const readScorecard = () => readAs(ScorecardSchema, "scorecard.json");
export const readCase = (relative: string) => readAs(EvalCaseSchema, relative);

/** A spec built from raw fields that skip validation, for tests that hash or probe input the schemas would refuse. */
export function unvalidated<T extends object>(fields: object): T {
  return Object.assign(partialFake<T>(), fields);
}

export function llmStep(variant: VariantSpec) {
  const step = variant.steps.summarize;
  if (step?.kind !== "llm") throw new Error("the fixture variant has no llm step named summarize");
  return step;
}

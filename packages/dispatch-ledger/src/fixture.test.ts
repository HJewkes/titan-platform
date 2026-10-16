import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaimSchema, LedgerSchema } from "./schema.js";
import { FIXTURE } from "./store.test-helpers.js";

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function innerType(schema: z.core.$ZodType): z.core.$ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return innerType(schema.unwrap());
  return schema;
}

/** Every object key under `schema` that none of `values` populates, as a dotted path; records and arrays pool their items. */
function unpopulatedKeys(schema: z.core.$ZodType, values: unknown[], at: string): string[] {
  const inner = innerType(schema);
  const present = values.filter((value) => value !== undefined && value !== null);
  if (inner instanceof z.ZodArray) {
    return unpopulatedKeys(inner.element, present.flatMap((v) => (Array.isArray(v) ? v : [])), `${at}[]`);
  }
  if (inner instanceof z.ZodRecord) {
    const items = present.flatMap((v) => (isPlain(v) ? Object.values(v) : []));
    return unpopulatedKeys(inner.valueType, items, `${at}{}`);
  }
  if (!(inner instanceof z.ZodObject)) return [];
  const objects = present.filter(isPlain);
  return Object.entries(inner.shape).flatMap(([key, child]) => {
    const path = at === "" ? key : `${at}.${key}`;
    const found = objects.filter((o) => Object.hasOwn(o, key)).map((o) => o[key]);
    return found.length === 0 ? [path] : unpopulatedKeys(child, found, path);
  });
}

/**
 * Nested claim keys the fixture does not populate yet; the fixture's bytes are pinned by the round-trip tests, so
 * filling them is its own change. Any other unpopulated key fails.
 */
const KNOWN_GAPS = ["claims[].stale.until", "claims[].checkpoint.failed"];

const gaps = (schema: z.core.$ZodType, ledger: unknown): string[] =>
  unpopulatedKeys(schema, [ledger], "").filter((path) => !KNOWN_GAPS.includes(path));

describe("burndown-ledger fixture", () => {
  it("populates every LedgerSchema key, every key of each section, and every ClaimSchema key across its claims", () => {
    expect(gaps(LedgerSchema, JSON.parse(FIXTURE))).toEqual([]);
    expect(unpopulatedKeys(LedgerSchema, [JSON.parse(FIXTURE)], "")).toEqual(KNOWN_GAPS);
  });

  it("names a schema key the fixture lacks", () => {
    const grown = LedgerSchema.extend({ newSection: z.object({ a: z.string() }).optional() });
    const grownClaim = LedgerSchema.extend({ claims: z.array(ClaimSchema.extend({ newKey: z.string().optional() })) });
    const withoutWake = LedgerSchema.parse(JSON.parse(FIXTURE));
    delete withoutWake.wake;

    expect(gaps(grown, JSON.parse(FIXTURE))).toEqual(["newSection"]);
    expect(gaps(grownClaim, JSON.parse(FIXTURE))).toEqual(["claims[].newKey"]);
    expect(gaps(LedgerSchema, withoutWake)).toEqual(["wake"]);
  });
});

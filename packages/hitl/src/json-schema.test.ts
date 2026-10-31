import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkAgainstJsonSchema } from "./json-schema.js";

const schemaFor = (schema: z.ZodType) => toRecord(z.toJSONSchema(schema));
const toRecord = (value: unknown) => value as Record<string, unknown>;

describe("checkAgainstJsonSchema", () => {
  it("accepts a payload matching a zod-derived object schema", () => {
    const schema = schemaFor(z.object({ approved: z.boolean(), note: z.string().optional() }));
    expect(checkAgainstJsonSchema(schema, { approved: true })).toEqual([]);
  });

  it("names the missing required field", () => {
    const schema = schemaFor(z.object({ approved: z.boolean() }));
    expect(checkAgainstJsonSchema(schema, {})).toEqual(["$.approved: required"]);
  });

  it("names the field whose type is wrong", () => {
    const schema = schemaFor(z.object({ approved: z.boolean() }));
    expect(checkAgainstJsonSchema(schema, { approved: "yes" })).toEqual([
      "$.approved: expected boolean, received string",
    ]);
  });

  it("rejects a property the schema did not declare", () => {
    const schema = schemaFor(z.object({ approved: z.boolean() }));
    expect(checkAgainstJsonSchema(schema, { approved: true, sneaky: 1 })).toEqual(["$.sneaky: unexpected property"]);
  });

  it("checks nested objects by path", () => {
    const schema = schemaFor(z.object({ who: z.object({ name: z.string() }) }));
    expect(checkAgainstJsonSchema(schema, { who: { name: 7 } })).toEqual(["$.who.name: expected string, received number"]);
  });

  it("checks each array element by index", () => {
    const schema = schemaFor(z.object({ tags: z.array(z.string()) }));
    expect(checkAgainstJsonSchema(schema, { tags: ["a", 2] })).toEqual(["$.tags[1]: expected string, received number"]);
  });

  it("enforces an enum", () => {
    const schema = schemaFor(z.object({ choice: z.enum(["yes", "no"]) }));
    expect(checkAgainstJsonSchema(schema, { choice: "maybe" })).toHaveLength(1);
    expect(checkAgainstJsonSchema(schema, { choice: "no" })).toEqual([]);
  });

  it("accepts a value matching either branch of a union", () => {
    const schema = schemaFor(z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]));
    expect(checkAgainstJsonSchema(schema, { b: 1 })).toEqual([]);
    expect(checkAgainstJsonSchema(schema, { c: true })).toHaveLength(1);
  });

  it("separates integer from number", () => {
    expect(checkAgainstJsonSchema({ type: "integer" }, 1.5)).toHaveLength(1);
    expect(checkAgainstJsonSchema({ type: "integer" }, 2)).toEqual([]);
  });

  it("does not mistake an array or null for an object", () => {
    expect(checkAgainstJsonSchema({ type: "object" }, [])).toEqual(["$: expected object, received array"]);
    expect(checkAgainstJsonSchema({ type: "object" }, null)).toEqual(["$: expected object, received null"]);
  });

  it("passes a schema with no type constraint", () => {
    expect(checkAgainstJsonSchema({}, "anything")).toEqual([]);
  });
});

const OPEN_SHARED = z.string().meta({ title: "Shared", description: "reused twice" });
const recursive = z.object({ value: z.string(), get next() { return recursive.optional(); } });

/** Every construct `openGate` can store: a gate built from any of them must stay answerable. */
const ZOD_CONSTRUCTS: [string, z.ZodType, unknown][] = [
  ["bounded string", z.string().min(1).max(5).regex(/a/), "a"],
  ["format string", z.email(), "a@example.com"],
  ["file", z.file().mime("image/png").max(5), "x"],
  ["bounded number", z.number().gt(1).lt(9).multipleOf(2), 2],
  ["integer", z.int(), 2],
  ["boolean", z.boolean(), true],
  ["null", z.null(), null],
  ["any", z.any(), "x"],
  ["object with optional", z.object({ a: z.string().optional() }), {}],
  ["object with default", z.object({ a: z.string().default("x") }), { a: "y" }],
  ["loose object", z.looseObject({ a: z.string() }), { a: "x", b: 1 }],
  ["catchall object", z.object({}).catchall(z.number()), { a: 1 }],
  ["record", z.record(z.string(), z.number()), { a: 1 }],
  ["enum-keyed record", z.record(z.enum(["a"]), z.number()), { a: 1 }],
  ["bounded array", z.array(z.string()).min(1).max(3), ["a"]],
  ["tuple", z.tuple([z.string(), z.number()]), ["a", 1]],
  ["empty-rest tuple in an object", z.object({ pair: z.tuple([z.string()]) }), { pair: ["a"] }],
  ["primitive union", z.union([z.string(), z.number()]), 1],
  ["nullable", z.string().nullable(), null],
  ["xor", z.xor([z.string(), z.number()]), 1],
  ["discriminated union", z.discriminatedUnion("k", [z.object({ k: z.literal("a") }), z.object({ k: z.literal("b") })]), { k: "b" }],
  ["intersection", z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })), { a: "x", b: "y" }],
  ["enum", z.enum(["a", "b"]), "a"],
  ["literal", z.literal("a"), "a"],
  ["mixed literal", z.literal(["a", 1]), 1],
  ["null literal", z.literal(null), null],
  ["recursive object", recursive, { value: "a", next: { value: "b" } }],
  ["json", z.json(), { a: [1, null] }],
  ["shared definition", z.object({ a: OPEN_SHARED, b: OPEN_SHARED }), { a: "x", b: "y" }],
  ["described with metadata", z.string().meta({ title: "T", description: "D", examples: ["a"], deprecated: true }), "a"],
  ["readonly", z.object({ a: z.string() }).readonly(), { a: "x" }],
  ["answer shapes in anyOf meta", z.object({ decision: z.string() }).meta({ anyOf: [{ type: "object", properties: { decision: { const: "yes" } }, required: ["decision"] }] }), { decision: "yes" }],
];

describe("gate decisions on well-formed schemas", () => {
  it.each(ZOD_CONSTRUCTS)("accepts a valid payload for a stored zod %s", (_name, schema, valid) => {
    expect(checkAgainstJsonSchema(z.toJSONSchema(schema), valid)).toEqual([]);
  });

  it("reads anyOf in place of its sibling keywords, which the factory's answer shapes rely on", () => {
    const schema = { type: "object", properties: { pin: { const: "a" } }, required: ["pin"], additionalProperties: false, anyOf: [{ type: "string" }] };
    expect(checkAgainstJsonSchema(schema, "text")).toEqual([]);
    expect(checkAgainstJsonSchema(schema, 1)).toEqual(["$: matched none of the 1 allowed shapes"]);
  });

  it("reads anyOf ahead of oneOf and lets one match satisfy oneOf", () => {
    expect(checkAgainstJsonSchema({ anyOf: [{ type: "string" }], oneOf: [{ type: "number" }] }, "text")).toEqual([]);
    expect(checkAgainstJsonSchema({ oneOf: [{ type: "string" }, { type: "string" }] }, "text")).toEqual([]);
  });

  it("refuses everything for an empty anyOf", () => {
    expect(checkAgainstJsonSchema({ anyOf: [] }, 1)).toEqual(["$: matched none of the 0 allowed shapes"]);
  });

  it("checks const, then enum, then type on one schema", () => {
    expect(checkAgainstJsonSchema({ const: "a", enum: ["a"], type: "string" }, "a")).toEqual([]);
    expect(checkAgainstJsonSchema({ const: "a", enum: ["b"], type: "string" }, "b")).toEqual(['$: expected "a"']);
    expect(checkAgainstJsonSchema({ const: "a", enum: ["b"], type: "string" }, "a")).toEqual(['$: expected one of ["b"]']);
    expect(checkAgainstJsonSchema({ enum: ["a", 1], type: "string" }, 1)).toEqual(["$: expected string, received number"]);
  });

  it("reads properties, required and additionalProperties only under type object", () => {
    expect(checkAgainstJsonSchema({ properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false }, { b: 1 })).toEqual([]);
  });

  it("reports the required, unexpected and nested issues of one object together", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"], additionalProperties: false };
    expect(checkAgainstJsonSchema(schema, { b: 1, c: 2 })).toEqual(["$.a: required", "$.c: unexpected property", "$.b: expected string, received number"]);
  });

  it("starts issue paths at the caller's path", () => {
    expect(checkAgainstJsonSchema({ type: "string" }, 1, "$.answer")).toEqual(["$.answer: expected string, received number"]);
  });

  it("refuses a non-finite number", () => {
    expect(checkAgainstJsonSchema({ type: "number" }, Number.NaN)).toEqual(["$: expected number, received number"]);
  });

  it("leaves to the waiter the zod constraints this boundary check never enforced", () => {
    expect(checkAgainstJsonSchema(z.toJSONSchema(z.string().min(5)), "a")).toEqual([]);
    expect(checkAgainstJsonSchema(z.toJSONSchema(z.string().nullable()), 42)).toEqual([]);
    expect(checkAgainstJsonSchema(z.toJSONSchema(z.never()), "x")).toEqual([]);
    expect(checkAgainstJsonSchema(z.toJSONSchema(z.record(z.string(), z.number())), { a: "x" })).toEqual([]);
    expect(checkAgainstJsonSchema(z.toJSONSchema(z.tuple([z.string()])), [1])).toEqual([]);
    expect(checkAgainstJsonSchema({ allOf: [{ type: "number" }] }, "x")).toEqual([]);
    expect(checkAgainstJsonSchema({ $ref: "#/$defs/n", $defs: { n: { type: "number" } } }, "x")).toEqual([]);
  });

  it("lets an inherited key satisfy required, as the checker always has", () => {
    expect(checkAgainstJsonSchema({ type: "object", required: ["toString"] }, {})).toEqual([]);
  });
});

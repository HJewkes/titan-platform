import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkAgainstJsonSchema } from "./json-schema.js";

const schemaFor = (schema: z.ZodType) => z.toJSONSchema(schema);
const UNREADABLE = /^\$: schema is unreadable: /;

function expectRefused(schema: unknown, value: unknown): void {
  const issues = checkAgainstJsonSchema(schema, value);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatch(UNREADABLE);
}

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
    expect(checkAgainstJsonSchema(z.toJSONSchema(z.record(z.string(), z.number())), { a: "x" })).toEqual([]);
  });

  it("lets an inherited key satisfy required, as the checker always has", () => {
    expect(checkAgainstJsonSchema({ type: "object", required: ["toString"] }, {})).toEqual([]);
  });
});

describe("annotation keywords", () => {
  it.each<[string, unknown]>([
    ["title", "T"], ["description", "D"], ["default", 1], ["examples", [1]], ["$comment", "c"], ["deprecated", true], ["readOnly", true], ["writeOnly", true],
    ["$id", "urn:example:a"], ["$anchor", "a"], ["format", "email"], ["contentEncoding", "base64"], ["contentMediaType", "text/plain"], ["contentSchema", {}], ["x-ui-hint", { rows: 3 }],
  ])("reads %s as an annotation that changes no decision", (keyword, value) => {
    const schema = { type: "object", properties: { a: { type: "string", [keyword]: value } }, required: ["a"], [keyword]: value };
    expect(checkAgainstJsonSchema(schema, { a: "x" })).toEqual([]);
    expect(checkAgainstJsonSchema(schema, { a: 1 })).toEqual(["$.a: expected string, received number"]);
  });

  it("does not read an annotation's value, whatever its shape", () => {
    expect(checkAgainstJsonSchema({ type: "string", description: 7, title: null, "x-note": [] }, "x")).toEqual([]);
  });

  it("keeps a custom .meta() annotation answerable", () => {
    const schema = z.toJSONSchema(z.object({ note: z.string().meta({ "x-widget": "textarea", title: "Note" }) }));
    expect(checkAgainstJsonSchema(schema, { note: "x" })).toEqual([]);
    expect(checkAgainstJsonSchema(schema, { note: 1 })).toEqual(["$.note: expected string, received number"]);
  });
});

describe("unreadable stored schemas", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["zero", 0],
    ["an empty string", ""],
    ["a string", "object"],
    ["a list", []],
    ["a Map", new Map()],
  ])("refuses a schema that is %s", (_name, schema) => {
    expectRefused(schema, "anything");
  });

  it.each<[string, unknown]>([
    ["a null anyOf branch", { anyOf: [null] }],
    ["a zero anyOf branch beside a good one", { anyOf: [0, { type: "string" }] }],
    ["a string oneOf branch", { oneOf: ["x", { type: "string" }] }],
    ["a null property schema", { type: "object", properties: { a: null } }],
    ["a zero items schema", { type: "array", items: 0 }],
    ["a null items schema", { type: "array", items: null }],
    ["a list items schema", { type: "array", items: [{ type: "string" }] }],
  ])("refuses %s even where the value never reaches it", (_name, schema) => {
    expectRefused(schema, "text");
  });

  it.each<[string, unknown]>([
    ["a non-list anyOf", { anyOf: "x" }],
    ["a non-list anyOf beside a good oneOf", { anyOf: { type: "string" }, oneOf: [{ type: "number" }] }],
    ["a bad oneOf behind a good anyOf", { anyOf: [{ type: "number" }], oneOf: "x" }],
    ["a bad sibling behind a good anyOf", { anyOf: [{ type: "number" }], type: 42 }],
    ["a non-list enum", { enum: "abc" }],
    ["a numeric type", { type: 42 }],
    ["a misspelled type", { type: "strnig" }],
    ["a misspelled type in a list", { type: ["string", "nul"] }],
    ["a non-map properties", { type: "object", properties: "x" }],
    ["a false properties", { type: "object", properties: false }],
    ["a non-list required", { type: "object", required: "a" }],
    ["a null required entry", { type: "object", required: [null] }],
    ["a zero additionalProperties", { type: "object", additionalProperties: 0 }],
    ["a bad entry deep in the tree", { type: "object", properties: { a: { type: "array", items: { anyOf: [{ enum: 1 }] } } } }],
    ["a bad schema under an unread properties", { properties: { a: null } }],
    ["a non-list allOf", { allOf: { type: "string" } }],
    ["a bad allOf branch", { allOf: [null] }],
    ["a bad prefixItems entry", { type: "array", prefixItems: [0] }],
    ["a bad not", { not: 0 }],
    ["a bad propertyNames", { propertyNames: null }],
    ["a bad definition", { $defs: { a: 0 } }],
    ["a non-string reference", { $ref: 1 }],
  ])("refuses a partially malformed schema: %s", (_name, schema) => {
    expectRefused(schema, 1);
  });

  it.each<[string, unknown]>([
    ["at the root", { typ: "string" }],
    ["inside properties", { type: "object", properties: { a: { minimun: 1 } } }],
    ["inside a union branch", { anyOf: [{ if: {} }] }],
    ["that merely starts with x", { xor: [] }],
    ["named after an Object method", { constructor: {} }],
    ["named __proto__", JSON.parse('{"__proto__": {}}')],
  ])("refuses an unknown keyword %s", (_name, schema) => {
    expectRefused(schema, { a: 1 });
  });

  it("names where the schema could not be read", () => {
    const schema = { type: "object", properties: { a: { anyOf: [{ typ: "string" }] } } };
    expect(checkAgainstJsonSchema(schema, {}, "$.answer")).toEqual(["$.answer: schema is unreadable: #/properties/a/anyOf/0: unknown keyword typ"]);
  });

  it("refuses a schema that refers to itself", () => {
    const schema: Record<string, unknown> = { type: "object" };
    schema.properties = { self: schema };
    expectRefused(schema, {});
  });
});

describe("boolean schemas", () => {
  it("reads true as accepting everything", () => {
    expect(checkAgainstJsonSchema(true, "anything")).toEqual([]);
    expect(checkAgainstJsonSchema({ anyOf: [true] }, 1)).toEqual([]);
    expect(checkAgainstJsonSchema({ type: "object", properties: { a: true } }, { a: 1 })).toEqual([]);
  });

  it("reads false as refusing every value", () => {
    expect(checkAgainstJsonSchema(false, "anything")).toEqual(["$: no value is allowed"]);
    expect(checkAgainstJsonSchema(false, undefined)).toEqual(["$: no value is allowed"]);
  });

  it("refuses a value at a false property and allows the property's absence", () => {
    const schema = { type: "object", properties: { admin: false } };
    expect(checkAgainstJsonSchema(schema, { admin: true })).toEqual(["$.admin: no value is allowed"]);
    expect(checkAgainstJsonSchema(schema, {})).toEqual([]);
  });

  it("treats a false union branch as one that never matches", () => {
    expect(checkAgainstJsonSchema({ anyOf: [false] }, 1)).toEqual(["$: matched none of the 1 allowed shapes"]);
    expect(checkAgainstJsonSchema({ anyOf: [false, { type: "number" }] }, 1)).toEqual([]);
  });

  it("refuses every element under items false", () => {
    expect(checkAgainstJsonSchema({ type: "array", items: false }, [1])).toEqual(["$[0]: no value is allowed"]);
    expect(checkAgainstJsonSchema({ type: "array", items: false }, [])).toEqual([]);
  });

  it("applies items only after a tuple's prefix", () => {
    const closed = z.toJSONSchema(z.tuple([z.string()]));
    expect(checkAgainstJsonSchema(closed, ["a", "extra"])).toEqual(["$[1]: no value is allowed"]);
    const rest = z.toJSONSchema(z.tuple([z.string()]).rest(z.number()));
    expect(checkAgainstJsonSchema(rest, ["a", 1])).toEqual([]);
    expect(checkAgainstJsonSchema(rest, ["a", "b"])).toEqual(["$[1]: expected number, received string"]);
  });
});

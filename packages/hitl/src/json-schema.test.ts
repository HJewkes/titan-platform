import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkAgainstJsonSchema } from "./json-schema.js";

const schemaFor = (schema: z.ZodType) => z.toJSONSchema(schema);

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

  describe("a schema that cannot be read", () => {
    const malformed: Array<[string, Record<string, unknown>]> = [
      ["a false union branch", { anyOf: [false] }],
      ["a non-object union branch", { anyOf: ["x", { type: "string" }] }],
      ["a false property schema", { type: "object", properties: { admin: false } }],
      ["a string property schema", { type: "object", properties: { n: "number" } }],
      ["a non-object properties map", { type: "object", properties: "bad" }],
      ["a null required entry", { type: "object", required: [null] }],
      ["an object required entry", { type: "object", required: [{}] }],
      ["a non-array required list", { type: "object", required: "name" }],
      ["a string items schema", { type: "array", items: "number" }],
      ["items: false", { type: "array", items: false }],
      ["items: 0", { type: "array", items: 0 }],
      ["items: null", { type: "array", items: null }],
      ["a non-array anyOf beside a usable oneOf", { anyOf: { type: "string" }, oneOf: [{ type: "number" }] }],
      ["a lone non-array anyOf", { anyOf: "x" }],
      ["a lone non-array oneOf", { oneOf: "x" }],
      ["a non-string type", { type: 42 }],
      ["an array type", { type: ["string"] }],
      ["a non-array enum", { enum: "abc" }],
    ];

    it.each(malformed)("refuses the payload for %s", (_label, schema) => {
      const payload = schema.type === "array" ? [1] : schema.type === "object" ? { admin: true, n: "str" } : 42;
      expect(checkAgainstJsonSchema(schema, payload)).not.toEqual([]);
    });

    it.each([false, 0, "", null, []])("refuses a top-level %j schema", (schema) => {
      const issues = z.array(z.string()).parse(Reflect.apply(checkAgainstJsonSchema, undefined, [schema, 42]));
      expect(issues).not.toEqual([]);
    });

    it("still accepts a true schema", () => {
      expect(checkAgainstJsonSchema({ type: "object", properties: { ok: true } }, { ok: 1 })).toEqual([]);
    });
  });
});

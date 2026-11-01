import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkAgainstJsonSchema } from "./json-schema.js";

const UNREADABLE = /^\$: schema is unreadable: /;

function expectRefused(schema: unknown, value: unknown, reason: RegExp): void {
  const issues = checkAgainstJsonSchema(schema, value);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatch(UNREADABLE);
  expect(issues[0]).toMatch(reason);
}

describe("allOf", () => {
  const schema = { allOf: [{ type: "object", required: ["a"] }, { type: "object", properties: { b: { type: "number" } } }] };

  it("accepts a value that fits every branch", () => {
    expect(checkAgainstJsonSchema(schema, { a: 1, b: 2 })).toEqual([]);
  });

  it("refuses a value that misses one branch and names each issue", () => {
    expect(checkAgainstJsonSchema(schema, { b: "x" })).toEqual(["$.a: required", "$.b: expected number, received string"]);
    expect(checkAgainstJsonSchema({ allOf: [{ type: "number" }] }, "x")).toEqual(["$: expected number, received string"]);
  });

  it("holds beside the node's own keywords", () => {
    const sibling = { type: "object", properties: { a: { type: "string" } }, allOf: [{ type: "object", required: ["a"] }] };
    expect(checkAgainstJsonSchema(sibling, { a: "x" })).toEqual([]);
    expect(checkAgainstJsonSchema(sibling, {})).toEqual(["$.a: required"]);
  });

  it("holds beside an anyOf, which still stands in for the other siblings", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }], allOf: [{ type: "number" }] };
    expect(checkAgainstJsonSchema(schema, 1)).toEqual([]);
    expect(checkAgainstJsonSchema(schema, "x")).toEqual(["$: expected number, received string"]);
  });
});

describe("not", () => {
  it("refuses a value matching the negated schema and accepts one that does not", () => {
    const schema = { type: "string", not: { const: "forbidden" } };
    expect(checkAgainstJsonSchema(schema, "fine")).toEqual([]);
    expect(checkAgainstJsonSchema(schema, "forbidden")).toEqual(["$: matched a shape it must not"]);
  });

  it("refuses everything for zod's never, as the waiter would", () => {
    expect(checkAgainstJsonSchema(z.toJSONSchema(z.never()), "x")).toEqual(["$: matched a shape it must not"]);
  });

  it("applies inside properties by path", () => {
    const schema = { type: "object", properties: { role: { not: { enum: ["admin"] } } } };
    expect(checkAgainstJsonSchema(schema, { role: "admin" })).toEqual(["$.role: matched a shape it must not"]);
    expect(checkAgainstJsonSchema(schema, { role: "viewer" })).toEqual([]);
  });
});

describe("prefixItems", () => {
  it("checks each positional element of a zod tuple", () => {
    const schema = z.toJSONSchema(z.tuple([z.string(), z.number()]));
    expect(checkAgainstJsonSchema(schema, ["a", 1])).toEqual([]);
    expect(checkAgainstJsonSchema(schema, [1, "a"])).toEqual(["$[0]: expected string, received number", "$[1]: expected number, received string"]);
  });

  it("leaves elements past the prefix to items", () => {
    const rest = z.toJSONSchema(z.tuple([z.string()]).rest(z.number()));
    expect(checkAgainstJsonSchema(rest, [1, 2])).toEqual(["$[0]: expected string, received number"]);
    expect(checkAgainstJsonSchema({ type: "array", prefixItems: [{ type: "string" }] }, ["a", 2, null])).toEqual([]);
  });

  it("does not require a prefix element the value leaves out", () => {
    expect(checkAgainstJsonSchema({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] }, ["a"])).toEqual([]);
  });
});

describe("$ref", () => {
  it("resolves a $defs reference", () => {
    const schema = { type: "object", properties: { n: { $ref: "#/$defs/n" } }, $defs: { n: { type: "number" } } };
    expect(checkAgainstJsonSchema(schema, { n: 1 })).toEqual([]);
    expect(checkAgainstJsonSchema(schema, { n: "x" })).toEqual(["$.n: expected number, received string"]);
  });

  it("resolves a definitions reference", () => {
    const schema = { $ref: "#/definitions/n", definitions: { n: { type: "number" } } };
    expect(checkAgainstJsonSchema(schema, 1)).toEqual([]);
    expect(checkAgainstJsonSchema(schema, "x")).toEqual(["$: expected number, received string"]);
  });

  it("decodes an escaped definition name", () => {
    const schema = { $ref: "#/$defs/a~1b%20c", $defs: { "a/b c": { type: "number" } } };
    expect(checkAgainstJsonSchema(schema, "x")).toEqual(["$: expected number, received string"]);
  });

  it("follows zod's recursive root and $defs references to any depth", () => {
    const node = z.object({ value: z.string(), get next() { return node.optional(); } });
    const atRoot = z.toJSONSchema(node);
    expect(checkAgainstJsonSchema(atRoot, { value: "a", next: { value: "b" } })).toEqual([]);
    expect(checkAgainstJsonSchema(atRoot, { value: "a", next: { value: "b", next: { value: 3 } } })).toEqual(["$.next.next.value: expected string, received number"]);
    const inDefs = z.toJSONSchema(z.object({ tree: node }));
    expect(checkAgainstJsonSchema(inDefs, { tree: { value: "a", next: { value: 3 } } })).toEqual(["$.tree.next.value: expected string, received number"]);
  });

  it("checks nested zod json arrays through the root reference", () => {
    const schema = z.toJSONSchema(z.json());
    expect(checkAgainstJsonSchema(schema, [[1, "a", null], { b: true }])).toEqual([]);
    expect(checkAgainstJsonSchema(schema, [[1, undefined]])).toEqual(["$: matched none of the 6 allowed shapes"]);
  });

  it.each<[string, unknown]>([
    ["a remote reference", { $ref: "https://example.test/schema.json" }],
    ["a relative file reference", { $ref: "other.json#/$defs/n" }],
    ["a pointer outside $defs and definitions", { $ref: "#/properties/a", properties: { a: { type: "string" } } }],
    ["a nested pointer inside $defs", { $ref: "#/$defs/a/properties/b", $defs: { a: { type: "object" } } }],
    ["an anchor", { $ref: "#a", $defs: { a: { $anchor: "a" } } }],
  ])("refuses %s at parse time", (_name, schema) => {
    expectRefused(schema, 1, /only a local reference/);
  });

  it.each<[string, unknown]>([
    ["a missing definition", { $ref: "#/$defs/missing", $defs: { n: { type: "number" } } }],
    ["no $defs at all", { $ref: "#/$defs/n" }],
    ["an inherited name", { $ref: "#/$defs/toString", $defs: {} }],
  ])("refuses an unresolvable reference: %s", (_name, schema) => {
    expectRefused(schema, 1, /unresolvable reference/);
  });

  it("refuses an unresolvable reference the value never reaches", () => {
    expectRefused({ type: "object", properties: { a: { $ref: "#/$defs/missing" } } }, {}, /unresolvable reference/);
  });

  it.each<[string, unknown]>([
    ["the root referring to itself", { $ref: "#" }],
    ["two definitions referring to each other", { $ref: "#/$defs/a", $defs: { a: { $ref: "#/$defs/b" }, b: { allOf: [{ $ref: "#/$defs/a" }] } } }],
    ["a cycle through anyOf and not", { $defs: { a: { anyOf: [{ not: { $ref: "#/$defs/a" } }] } } }],
  ])("refuses a reference cycle that consumes no value: %s", (_name, schema) => {
    expectRefused(schema, 1, /reference cycle/);
  });

  it("refuses a schema whose references expand past the check budget", () => {
    const $defs = Object.fromEntries(Array.from({ length: 30 }, (_unused, index) => [`d${index}`, { allOf: [{ $ref: `#/$defs/d${index + 1}` }, { $ref: `#/$defs/d${index + 1}` }] }]));
    expectRefused({ $ref: "#/$defs/d0", $defs: { ...$defs, d30: {} } }, 1, /references expand past/);
  });
});

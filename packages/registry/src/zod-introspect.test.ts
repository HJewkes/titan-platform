import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldSchema, isOptionalField, schemaKind, unwrapSchema } from "./zod-introspect.js";

const args = z.object({
  name: z.string(),
  count: z.number().optional(),
  tags: z.array(z.string()).nullable().optional(),
  mode: z.enum(["a", "b"]).default("a"),
  verbose: z.boolean().default(false).nullable(),
});

describe("unwrapSchema and schemaKind", () => {
  it("returns the bare schema's kind", () => {
    expect(schemaKind(args.shape.name)).toBe("string");
  });

  it("peels optional, nullable, and default wrappers in any nesting", () => {
    expect(schemaKind(args.shape.count)).toBe("number");
    expect(schemaKind(args.shape.tags)).toBe("array");
    expect(schemaKind(args.shape.mode)).toBe("enum");
    expect(schemaKind(args.shape.verbose)).toBe("boolean");
    expect(unwrapSchema(args.shape.verbose)).toBeInstanceOf(z.ZodBoolean);
  });

  it("is undefined for a missing schema", () => {
    expect(schemaKind(undefined)).toBeUndefined();
  });
});

describe("fieldSchema", () => {
  it("returns the field schema from a top-level object", () => {
    expect(fieldSchema(args, "name")).toBe(args.shape.name);
  });

  it("is undefined for an absent field or a non-object schema", () => {
    expect(fieldSchema(args, "nope")).toBeUndefined();
    expect(fieldSchema(z.string(), "name")).toBeUndefined();
  });
});

describe("isOptionalField", () => {
  it("treats optional and default fields as omittable", () => {
    expect(isOptionalField(args.shape.count)).toBe(true);
    expect(isOptionalField(args.shape.mode)).toBe(true);
  });

  it("treats required and merely nullable fields as required", () => {
    expect(isOptionalField(args.shape.name)).toBe(false);
    expect(isOptionalField(z.string().nullable())).toBe(false);
    expect(isOptionalField(undefined)).toBe(false);
  });
});

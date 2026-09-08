import { ZodDefault, ZodNullable, ZodObject, ZodOptional, type ZodType } from "zod";

/** The zod 4 `def.type` discriminator of a schema, e.g. "string", "array", "enum". */
export type SchemaKind = string;

type Wrapper = ZodOptional<ZodType> | ZodNullable<ZodType> | ZodDefault<ZodType>;

function isWrapper(schema: ZodType): schema is Wrapper {
  return schema instanceof ZodOptional || schema instanceof ZodNullable || schema instanceof ZodDefault;
}

/** Peel optional / nullable / default wrappers down to the schema that carries the kind. */
export function unwrapSchema(schema: ZodType): ZodType {
  let current = schema;
  while (isWrapper(current)) current = current.unwrap() as ZodType;
  return current;
}

/** Kind of the innermost schema, using zod 4's public `def` rather than `_zod` internals. */
export function schemaKind(schema: ZodType | undefined): SchemaKind | undefined {
  if (!schema) return undefined;
  return unwrapSchema(schema).def.type;
}

/** The per-field schema of a top-level `z.object`, or undefined when there is none. */
export function fieldSchema(args: ZodType, name: string): ZodType | undefined {
  if (!(args instanceof ZodObject)) return undefined;
  return (args.shape as Record<string, ZodType | undefined>)[name];
}

/** True when the field may be omitted from input: `.optional()` or `.default()`. */
export function isOptionalField(schema: ZodType | undefined): boolean {
  return schema instanceof ZodOptional || schema instanceof ZodDefault;
}

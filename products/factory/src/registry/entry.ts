import { z } from "zod";
import type { StepKind } from "../definition.js";

/** Who performs the step: software, or a step the recipe docs mark AGENT or OWNER. */
type Kind = "software" | "AGENT" | "OWNER";
type EffectTarget = "commit" | "pr" | "item" | "external";

/**
 * A read's orphan is dropped on restart; every other class parks, and must say why. `pending` is a read not yet
 * reviewed (TP-3106 S3, S4): it parks like an effect, and S4 deletes the shape.
 */
type Effect =
  | { class: "read" }
  | { class: "pending"; reason: string }
  | { class: "effect" | "irreversible"; target: EffectTarget; reason: string };

export interface BaseEntry {
  /** The StepDeclaration id; a family name covers `<name>:<suffix>`. */
  name: string;
  op: StepKind;
  kind: Kind;
  effect: Effect;
  callSites: readonly string[];
  /** The schema hash is computed from the schemas, never written here. */
  version: { bump: number };
  claims?: readonly { pool: string }[];
  startSet?: true;
}

/** An entry that writes a fact. Its pin class is the rule file's row for `fact`, never a field of its own. */
export interface FactEntry extends BaseEntry {
  fact: string;
  input: z.ZodType;
  output: z.ZodType;
  materialInputs: readonly { fact: string; fields: readonly string[] }[];
  /** The output field paths a dependent may read. */
  projection: readonly string[];
  idempotencyKey: (input: unknown) => string;
  /** The repo-relative module whose import closure is hashed. */
  body: string;
}

export type StepEntry = BaseEntry | FactEntry;

const nonEmpty = z.string().min(1);

const effectSchema = z.discriminatedUnion("class", [
  z.strictObject({ class: z.literal("read") }),
  z.strictObject({ class: z.literal("pending"), reason: nonEmpty }),
  z.strictObject({ class: z.enum(["effect", "irreversible"]), target: z.enum(["commit", "pr", "item", "external"]), reason: nonEmpty }),
]);

const baseShape = {
  name: nonEmpty,
  op: z.enum(["dispatch", "seed", "assisted", "authorize"]),
  kind: z.enum(["software", "AGENT", "OWNER"]),
  effect: effectSchema,
  callSites: z.array(nonEmpty),
  version: z.strictObject({ bump: z.number().int().nonnegative() }),
  claims: z.array(z.strictObject({ pool: nonEmpty })).optional(),
  startSet: z.literal(true).optional(),
};

const factShape = {
  ...baseShape,
  fact: nonEmpty,
  input: z.instanceof(z.ZodType),
  output: z.instanceof(z.ZodType),
  materialInputs: z.array(z.strictObject({ fact: nonEmpty, fields: z.array(nonEmpty) })),
  projection: z.array(nonEmpty),
  idempotencyKey: z.custom<(input: unknown) => string>((value) => typeof value === "function"),
  body: nonEmpty,
};

const baseEntrySchema = z.strictObject(baseShape);
const factEntrySchema = z.strictObject(factShape);

export function isFactEntry(entry: StepEntry): entry is FactEntry {
  return "fact" in entry;
}

/**
 * The meta-schema check. Both shapes are strict, so an entry that declares a `pinClass` is refused, and an
 * entry naming a `fact` must carry every fact field (O2: the fact fields exist only on fact entries).
 */
export function entryProblems(entry: StepEntry): string | undefined {
  const parsed = (isFactEntry(entry) ? factEntrySchema : baseEntrySchema).safeParse(entry);
  return parsed.success ? undefined : z.prettifyError(parsed.error);
}

/** Typed identity: an entry is checked against the meta-schema when a registry is created. */
export function defineStep<E extends StepEntry>(entry: E): E {
  return entry;
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";
import { COMMAND_NAMES, CONTRACT, serializeContract, type SerializedContract } from "./query/contract.js";

// The lock pins the wire contract; regenerate with UPDATE_CONTRACT_LOCK=1 after bumping CODE_READ_API_VERSION.
const LOCK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "contract.lock.json");
const REGENERATE = "UPDATE_CONTRACT_LOCK=1 pnpm vitest run packages/code-read/src/contract-lock.test.ts";

type Schema = Record<string, unknown>;

const LockSchema = z.object({ api: z.string(), commands: z.record(z.string(), z.object({ args: z.unknown(), result: z.unknown() })) });
type Lock = z.output<typeof LockSchema>;

const isRecord = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

function schemaOf(value: unknown): Schema {
  if (!isRecord(value)) throw new Error("expected a JSON Schema object");
  return value;
}

const propsOf = (value: unknown): Schema => schemaOf(schemaOf(value).properties);

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((k): k is string => typeof k === "string") : []);

function readLock(): Lock | null {
  return existsSync(LOCK_PATH) ? LockSchema.parse(JSON.parse(readFileSync(LOCK_PATH, "utf8"))) : null;
}

const stable = (value: unknown): string => JSON.stringify(value);

function keyChanges(before: Schema, after: Schema, at: string): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("properties");
  keys.delete("required");
  keys.delete("items");
  return [...keys].filter((k) => stable(before[k]) !== stable(after[k])).map((k) => `${at}: "${k}" changed`);
}

function requiredChanges(before: Schema, after: Schema, at: string, io: "args" | "result"): string[] {
  const was = new Set(stringsOf(before.required));
  const now = new Set(stringsOf(after.required));
  // A new required argument breaks callers; a result field that may now be absent breaks readers.
  const [from, to] = io === "args" ? [was, now] : [now, was];
  return [...to].filter((k) => !from.has(k)).map((k) => `${at}.${k}: ${io === "args" ? "now required" : "now optional"}`);
}

/** Every change that is not provably additive; a non-empty list means the bump must be breaking. */
function breakingChanges(before: Schema, after: Schema, at: string, io: "args" | "result"): string[] {
  if (stable(before) === stable(after)) return [];
  const out = [...keyChanges(before, after, at), ...requiredChanges(before, after, at, io)];
  const oldProps = isRecord(before.properties) ? before.properties : {};
  const newProps = isRecord(after.properties) ? after.properties : {};
  for (const [key, schema] of Object.entries(oldProps)) {
    const next = newProps[key];
    out.push(...(next ? breakingChanges(schemaOf(schema), schemaOf(next), `${at}.${key}`, io) : [`${at}.${key}: removed`]));
  }
  if (isRecord(before.items) && isRecord(after.items)) out.push(...breakingChanges(before.items, after.items, `${at}[]`, io));
  return out;
}

function contractBreaks(lock: Lock, current: SerializedContract): string[] {
  return Object.entries(lock.commands).flatMap(([name, was]) => {
    const now = current.commands[name];
    if (!now) return [`${name}: command removed`];
    return [
      ...breakingChanges(schemaOf(was.args), schemaOf(now.args), `${name} args`, "args"),
      ...breakingChanges(schemaOf(was.result), schemaOf(now.result), `${name} result`, "result"),
    ];
  });
}

function explainDrift(lock: Lock, current: SerializedContract): string {
  const breaks = contractBreaks(lock, current);
  const bump = breaks.length > 0 ? "a breaking bump (major; minor while 0.x)" : "an additive bump (minor; patch while 0.x)";
  return [
    `The read API contract changed but CODE_READ_API_VERSION is still ${current.api}.`,
    `This change needs ${bump}.`,
    ...breaks.map((b) => `  breaking: ${b}`),
    `Bump CODE_READ_API_VERSION in src/query/contract.ts, then run: ${REGENERATE}`,
  ].join("\n");
}

describe("contract lock", () => {
  const current = serializeContract();
  const lock = readLock();

  it.runIf(process.env.UPDATE_CONTRACT_LOCK)("regenerates the lock only alongside a version bump", () => {
    if (lock && stable(lock.commands) !== stable(current.commands) && lock.api === current.api) {
      throw new Error(explainDrift(lock, current));
    }
    writeFileSync(LOCK_PATH, `${JSON.stringify(current, null, 2)}\n`);
  });

  it.skipIf(process.env.UPDATE_CONTRACT_LOCK)("matches the checked-in lock", () => {
    expect(lock, `contract.lock.json is missing; run: ${REGENERATE}`).not.toBeNull();
    if (stable(lock!.commands) !== stable(current.commands) && lock!.api === current.api) {
      expect.fail(explainDrift(lock!, current));
    }
    expect(lock!.api, `CODE_READ_API_VERSION is ${current.api} but the lock records ${lock!.api}; run: ${REGENERATE}`).toBe(current.api);
  });
});

describe("contract drift classification", () => {
  const base = serializeContract();
  const edit = (mutate: (c: Lock) => void): Lock => {
    const copy = LockSchema.parse(JSON.parse(JSON.stringify(base)));
    mutate(copy);
    return copy;
  };

  it("calls a removed result field breaking and names it", () => {
    const next = edit((c) => delete propsOf(c.commands["snapshot.list"]!.result).snapshots);

    expect(explainDrift(base, next)).toMatch(/breaking bump[\s\S]*snapshot\.list result\.snapshots: removed/);
  });

  it("calls a new optional argument additive", () => {
    const next = edit((c) => (propsOf(c.commands["snapshot.list"]!.args).since = { type: "string" }));

    expect(explainDrift(base, next)).toContain("an additive bump");
  });

  it("calls a newly required argument breaking", () => {
    const next = edit((c) => (schemaOf(c.commands["snapshot.list"]!.args).required = ["ref"]));

    expect(explainDrift(base, next)).toContain("snapshot.list args.ref: now required");
  });

  it("calls a removed command breaking", () => {
    const next = edit((c) => delete c.commands["api.describe"]);

    expect(explainDrift(base, next)).toContain("api.describe: command removed");
  });
});

// Each entry names a command whose schema carries a predicate the lock cannot see, and records who decided its bump and why.
const PREDICATE_ALLOW_LIST: Record<string, string> = {};

// JSON Schema drops these: refine/superRefine checks, z.custom, and transform/preprocess steps.
const INVISIBLE_TYPES = new Set(["custom", "transform"]);

function isCustomCheck(check: unknown): boolean {
  if (!isRecord(check) || !isRecord(check._zod)) return false;
  return isRecord(check._zod.def) && check._zod.def.check === "custom";
}

function isSchema(value: unknown): value is ZodType {
  return typeof value === "object" && value !== null && "_zod" in value && "def" in value;
}

function childSchemas(key: string, value: unknown): [string, ZodType][] {
  if (isSchema(value)) return [[`(${key})`, value]];
  if (Array.isArray(value)) return value.filter(isSchema).map((v, i) => [`(${key}[${i}])`, v]);
  if (key === "shape" && typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]): [string, ZodType][] => (isSchema(v) ? [[`.${k}`, v]] : []));
  }
  return [];
}

/** Paths inside a zod schema whose validation JSON Schema cannot represent, so the lock would not notice them change. */
function invisiblePredicates(schema: ZodType, at: string, seen = new Set<ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schemaOf(schema.def);
  const type = typeof def.type === "string" ? def.type : "";
  const out = INVISIBLE_TYPES.has(type) ? [`${at}: ${type}`] : [];
  if (Array.isArray(def.checks) && def.checks.some(isCustomCheck)) out.push(`${at}: refine or superRefine`);
  for (const [key, value] of Object.entries(def)) {
    if (key === "checks") continue;
    for (const [step, child] of childSchemas(key, value)) out.push(...invisiblePredicates(child, `${at}${step}`, seen));
  }
  return out;
}

describe("predicates the lock cannot see", () => {
  it("finds refinements and transforms at any depth", () => {
    const schema = z.object({
      a: z.array(z.string().refine((s) => s.length > 0)).optional(),
      b: z.union([z.number(), z.record(z.string(), z.number().superRefine(() => undefined))]),
      c: z.string().transform((s) => s.trim()),
      d: z.string().min(1),
    });

    expect(invisiblePredicates(schema, "x")).toEqual([
      "x.a(innerType)(element): refine or superRefine",
      "x.b(options[1])(valueType): refine or superRefine",
      "x.c(out): transform",
    ]);
  });

  it.each(COMMAND_NAMES)("%s has none, or is on the allow-list with a recorded bump decision", (name) => {
    const { args, result } = CONTRACT[name];
    const found = [...invisiblePredicates(args, `${name} args`), ...invisiblePredicates(result, `${name} result`)];
    if (found.length === 0 || name in PREDICATE_ALLOW_LIST) return;
    expect.fail(
      [
        `${name} uses validation that contract.lock.json cannot see, so changing it would never demand a version bump:`,
        ...found.map((f) => `  ${f}`),
        "Express the rule in schema terms JSON Schema carries (min, max, enum, regex, int), or add the command to",
        "PREDICATE_ALLOW_LIST in src/contract-lock.test.ts with a comment recording the manual bump decision.",
      ].join("\n"),
    );
  });
});

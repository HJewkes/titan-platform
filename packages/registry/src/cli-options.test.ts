import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  camelizeFlagKey,
  coerceCliValue,
  collectCliArgs,
  collectOptionParser,
  commandPath,
  flagToKey,
  optionFlagSpec,
  positionalSpec,
  readCommanderOption,
} from "./cli-options.js";
import { defineCommand } from "./types.js";

const wrap = defineCommand({
  name: "wrap",
  description: "wrap a session",
  args: z.object({
    slug: z.string(),
    note: z.string().optional(),
    ship_target: z.string().optional(),
    no_loops: z.boolean().optional(),
    limit: z.number().optional(),
    tags: z.array(z.string()).optional(),
    scores: z.array(z.number()).optional(),
    roles: z.array(z.enum(["reader", "writer"])).optional(),
    labels: z.array(z.string()).default(["untriaged"]),
    dry_run: z.boolean().optional(),
  }),
  result: z.void(),
  cli: {
    positional: ["slug", "note"],
    options: {
      ship_target: { long: "--ship-target", description: "target" },
      no_loops: { long: "--no-loops", description: "assert no loops" },
      limit: { long: "--limit", short: "-n", description: "limit" },
      tags: { long: "--tags", description: "tags" },
      scores: { long: "--score", description: "scores" },
      roles: { long: "--role", description: "roles" },
      labels: { long: "--label", description: "labels" },
      dry_run: { long: "--dry-run", description: "dry run" },
    },
  },
  async run() {},
});

describe("flag key mapping", () => {
  it("maps hyphenated flags to snake_case keys and back to commander camelCase", () => {
    expect(flagToKey("--ship-target")).toBe("ship_target");
    expect(camelizeFlagKey("ship_target")).toBe("shipTarget");
  });

  it("splits dotted command names into a sub-command path", () => {
    expect(commandPath("task.add")).toEqual(["task", "add"]);
    expect(commandPath("wrap")).toEqual(["wrap"]);
  });
});

describe("readCommanderOption", () => {
  it("reads a --no-* flag off commander's negated stem", () => {
    expect(readCommanderOption({ loops: false }, "--no-loops")).toBe(true);
    expect(readCommanderOption({}, "--no-loops")).toBeUndefined();
  });

  it("does not hand the negation's false to the paired value flag", () => {
    expect(readCommanderOption({ notes: false }, "--notes")).toBeUndefined();
  });

  it("reads camelCase then snake_case keys", () => {
    expect(readCommanderOption({ shipTarget: "npm" }, "--ship-target")).toBe("npm");
    expect(readCommanderOption({ ship_target: "npm" }, "--ship-target")).toBe("npm");
  });
});

describe("coerceCliValue", () => {
  it("coerces by schema kind and leaves unknown kinds alone", () => {
    expect(coerceCliValue("true", "boolean")).toBe(true);
    expect(coerceCliValue("42", "number")).toBe(42);
    expect(coerceCliValue("abc", "number")).toBe("abc");
    expect(coerceCliValue("x", "string")).toBe("x");
    expect(coerceCliValue(undefined, "number")).toBeUndefined();
  });

  it("wraps a single array value into a one-element array, never a bare string", () => {
    expect(coerceCliValue("a", "array", "string")).toEqual(["a"]);
  });

  it("passes through the many values a repeatable flag already collected", () => {
    expect(coerceCliValue(["a", "b", "c"], "array", "string")).toEqual(["a", "b", "c"]);
  });

  it("coerces each array element by the element kind", () => {
    expect(coerceCliValue(["1", "2"], "array", "number")).toEqual([1, 2]);
  });

  it("leaves enum elements as raw strings for zod to validate", () => {
    expect(coerceCliValue(["reader", "bogus"], "array", "enum")).toEqual(["reader", "bogus"]);
  });
});

describe("collectOptionParser", () => {
  it("gives an accumulator for an array-typed field", () => {
    const parser = collectOptionParser(wrap, "tags");
    expect(parser).toBeTypeOf("function");
    expect(parser!("a", undefined)).toEqual(["a"]);
    expect(parser!("b", ["a"])).toEqual(["a", "b"]);
  });

  it("is undefined for a scalar or boolean field", () => {
    expect(collectOptionParser(wrap, "ship_target")).toBeUndefined();
    expect(collectOptionParser(wrap, "dry_run")).toBeUndefined();
  });
});

describe("collectCliArgs", () => {
  it("assembles positionals and options into the args record, coerced", () => {
    const raw = collectCliArgs(wrap, ["tp", undefined], { loops: false, limit: "3", tags: ["a", "b"], dryRun: true });
    expect(raw).toEqual({ slug: "tp", no_loops: true, limit: 3, tags: ["a", "b"], dry_run: true });
  });

  it("produces args that pass the command's own schema", () => {
    const raw = collectCliArgs(wrap, ["tp"], { shipTarget: "npm" });
    expect(wrap.args.safeParse(raw).success).toBe(true);
  });

  it("leaves an array field undefined when its flag never occurred, so zod's default applies", () => {
    const raw = collectCliArgs(wrap, ["tp"], {});
    expect(raw).not.toHaveProperty("labels");
    expect(wrap.args.parse(raw).labels).toEqual(["untriaged"]);
  });

  it("turns one occurrence of a repeatable flag into a one-element array", () => {
    const raw = collectCliArgs(wrap, ["tp"], { tags: ["a"] });
    expect(raw.tags).toEqual(["a"]);
  });

  it("turns many occurrences of a repeatable flag into a many-element array", () => {
    const raw = collectCliArgs(wrap, ["tp"], { tags: ["a", "b", "c"] });
    expect(raw.tags).toEqual(["a", "b", "c"]);
  });

  it("coerces an array of numbers element by element", () => {
    const raw = collectCliArgs(wrap, ["tp"], { score: ["1", "2.5"] });
    expect(raw.scores).toEqual([1, 2.5]);
  });

  it("rejects an array of enums with an invalid member at schema validation", () => {
    const raw = collectCliArgs(wrap, ["tp"], { role: ["reader", "bogus"] });
    expect(raw.roles).toEqual(["reader", "bogus"]);
    expect(wrap.args.safeParse(raw).success).toBe(false);
  });

  it("accepts an array of enums whose members all validate", () => {
    const raw = collectCliArgs(wrap, ["tp"], { role: ["reader", "writer"] });
    expect(wrap.args.safeParse(raw).success).toBe(true);
  });
});

describe("commander spec strings", () => {
  it("renders boolean options as bare flags and others with a value", () => {
    expect(optionFlagSpec(wrap, "dry_run", wrap.cli!.options!.dry_run!)).toBe("--dry-run");
    expect(optionFlagSpec(wrap, "limit", wrap.cli!.options!.limit!)).toBe("-n, --limit <value>");
  });

  it("renders an array-typed field the same as a scalar; only repetition differs", () => {
    expect(optionFlagSpec(wrap, "tags", wrap.cli!.options!.tags!)).toBe("--tags <value>");
  });

  it("brackets optional positionals", () => {
    expect(positionalSpec(wrap, "slug")).toBe("<slug>");
    expect(positionalSpec(wrap, "note")).toBe("[note]");
  });
});

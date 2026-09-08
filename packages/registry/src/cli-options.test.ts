import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  camelizeFlagKey,
  coerceCliValue,
  collectCliArgs,
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
    expect(coerceCliValue("a, b,,c", "array")).toEqual(["a", "b", "c"]);
    expect(coerceCliValue("x", "string")).toBe("x");
    expect(coerceCliValue(undefined, "number")).toBeUndefined();
  });
});

describe("collectCliArgs", () => {
  it("assembles positionals and options into the args record, coerced", () => {
    const raw = collectCliArgs(wrap, ["tp", undefined], { loops: false, limit: "3", tags: "a,b", dryRun: true });
    expect(raw).toEqual({ slug: "tp", no_loops: true, limit: 3, tags: ["a", "b"], dry_run: true });
  });

  it("produces args that pass the command's own schema", () => {
    const raw = collectCliArgs(wrap, ["tp"], { shipTarget: "npm" });
    expect(wrap.args.safeParse(raw).success).toBe(true);
  });
});

describe("commander spec strings", () => {
  it("renders boolean options as bare flags and others with a value", () => {
    expect(optionFlagSpec(wrap, "dry_run", wrap.cli!.options!.dry_run!)).toBe("--dry-run");
    expect(optionFlagSpec(wrap, "limit", wrap.cli!.options!.limit!)).toBe("-n, --limit <value>");
  });

  it("brackets optional positionals", () => {
    expect(positionalSpec(wrap, "slug")).toBe("<slug>");
    expect(positionalSpec(wrap, "note")).toBe("[note]");
  });
});

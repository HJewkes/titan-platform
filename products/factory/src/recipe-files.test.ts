import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const STEP_OP = /\b(?:step|codeStep)\(ctx\b|\bctx\.(?:dispatch|seed|assisted|authorize)\(/;
const isSource = (name: string) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test-support" ? [] : sourceFiles(path);
    return isSource(entry.name) ? [path] : [];
  });
}

const listed: string[] = JSON.parse(readFileSync(join(SRC, "recipe-files.json"), "utf8"));

describe("recipe-files.json", () => {
  it("every factory source file that calls a step op is listed as a recipe file, and every listed file exists", () => {
    const calling = sourceFiles(SRC)
      .filter((file) => STEP_OP.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file))
      .sort();

    expect(calling).toEqual([...listed].sort());
    expect(listed.filter((file) => !existsSync(join(SRC, file)))).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../dist/mod/register.js", import.meta.url));
const IMPORT_SPECIFIER = /^\s*(?:import|export)\b[^"'\n]*?["']([^"']+)["']/gm;

describe("the built mod", () => {
  it("imports nothing but the host, because Claude Code loads the file on its own", () => {
    const text = readFileSync(BUNDLE, "utf8");

    const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map((match) => match[1]);

    expect(specifiers.filter((specifier) => specifier !== "claude-code")).toEqual([]);
  });
});

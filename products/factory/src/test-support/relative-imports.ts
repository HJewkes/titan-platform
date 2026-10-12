import { readFileSync } from "node:fs";

const SPECIFIER = /^\s*(?:import|export)\b[^'";]*?\bfrom\s+["'](\.[^"']+)["']/gm;

/** The relative specifiers a factory source file imports or re-exports from, read from its text; `file` is relative to `src`. */
export function relativeImports(file: string): string[] {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  return [...text.matchAll(SPECIFIER)].map((match) => match[1]!);
}

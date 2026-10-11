import { parseMemoryFile } from "./parse.js";
import type { MemoryFactType, ParsedFact } from "./types.js";

export interface FactSpec {
  name?: string;
  description?: string;
  body?: string;
  type?: MemoryFactType;
  project?: string;
  modified?: string;
}

/** A parsed fact built from a synthetic file, so tests go through the real parser. */
export function fact(file: string, spec: FactSpec = {}): ParsedFact {
  const { name = file, description = "", body = "", type = "feedback", project = "p1", modified } = spec;
  const lines = ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`, "metadata:", `  type: ${type}`];
  if (modified) lines.push(`  modified: ${modified}`);
  const raw = [...lines, "---", "", body, ""].join("\n");
  const result = parseMemoryFile(raw, { account: "default", project, path: `/memory/${project}/${file}.md` });
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** A deterministic shuffle, so order-independence tests do not depend on Math.random. */
export function reversedRotation<T>(items: readonly T[]): T[] {
  const reversed = [...items].reverse();
  return [...reversed.slice(1), ...reversed.slice(0, 1)];
}

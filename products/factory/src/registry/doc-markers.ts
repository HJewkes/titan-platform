import { entryFor, type createRegistry } from "./registry.js";

type Registry = ReturnType<typeof createRegistry>;

/** A recipe doc and the step ids its workflow declares. */
export interface RecipeDoc {
  path: string;
  text: string;
  stepIds: readonly string[];
}

const ROW = /^\|\s*`([^`]+)`\s*\|\s*(AGENT|OWNER)\s*\|\s*$/;

/** The marked rows of a doc's `## Steps` table; a mention anywhere else never counts. */
export function markedRows(text: string): Map<string, string> {
  const section = text.split(/^## /m).find((part) => /^Steps\s*\n/.test(part)) ?? "";
  const rows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const match = ROW.exec(line.trim());
    if (match?.[1] && match[2]) rows.set(match[1], match[2]);
  }
  return rows;
}

/** Problems where a doc's Steps table and the registry disagree about which steps an agent or the owner answers. */
export function lintDocMarkers(docs: readonly RecipeDoc[], registry: Registry): string[] {
  const problems: string[] = [];
  for (const doc of docs) {
    const rows = markedRows(doc.text);
    for (const [id, marker] of rows) {
      const kind = registry.entries.find((entry) => entry.name === id)?.kind;
      if (!kind) problems.push(`${doc.path}: row "${id}" is not a registered step`);
      else if (kind !== marker) problems.push(`${doc.path}: row "${id}" is marked ${marker}, but the registry says ${kind}`);
    }
    for (const id of doc.stepIds) {
      const kind = entryFor(registry, id)?.kind;
      if (kind && kind !== "software" && !rows.has(id)) problems.push(`${doc.path}: ${kind} step "${id}" is missing from the Steps table`);
    }
  }
  return problems;
}

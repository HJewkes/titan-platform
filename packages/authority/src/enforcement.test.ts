import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Enforcement } from "./enforcement.js";
import { ENFORCEMENT, enforcementSchema } from "./enforcement.js";
import { DEFAULT_TABLE } from "./table.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ruleById = new Map(DEFAULT_TABLE.rules.map((rule) => [rule.id, rule]));
const entries = Object.entries(ENFORCEMENT);

type LocalMechanism = Extract<Enforcement, { repo: "titan-platform" }>;

function localMechanisms(): LocalMechanism[] {
  const all = Object.values(ENFORCEMENT).flat().filter((cite): cite is LocalMechanism => "path" in cite);
  return [...new Map(all.map((cite) => [`${cite.path}#${cite.symbol}`, cite])).values()];
}

/** A TypeScript citation must be an export, so a renamed function cannot hide behind a comment that mentions it. */
function declares(source: string, cite: LocalMechanism): boolean {
  const pattern = cite.path.endsWith(".ts")
    ? new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|class|type|interface|enum)\\s+${cite.symbol}\\b`, "m")
    : new RegExp(`^\\s*${cite.symbol}:`, "m");
  return pattern.test(source);
}

function unresolved(cites: readonly LocalMechanism[]): string[] {
  return cites
    .filter((cite) => {
      const file = path.join(repoRoot, cite.path);
      return !existsSync(file) || !declares(readFileSync(file, "utf8"), cite);
    })
    .map((cite) => `${cite.path}#${cite.symbol}`);
}

describe("ENFORCEMENT", () => {
  it("cites exactly the rule ids in DEFAULT_TABLE", () => {
    expect(Object.keys(ENFORCEMENT).sort()).toEqual(DEFAULT_TABLE.rules.map((rule) => rule.id).sort());
  });

  it("matches enforcementSchema, with at least one citation per row", () => {
    expect(enforcementSchema.safeParse(ENFORCEMENT).success).toBe(true);
  });

  it("resolves every titan-platform citation to an existing file that declares its symbol", () => {
    expect(unresolved(localMechanisms())).toEqual([]);
  });

  it("flags a citation whose symbol was renamed away", () => {
    const renamed: LocalMechanism = { kind: "mechanism", repo: "titan-platform", path: "packages/authority/src/evaluate.ts", symbol: "canResolveRenamed" };
    expect(unresolved([renamed])).toEqual(["packages/authority/src/evaluate.ts#canResolveRenamed"]);
  });

  it("uses inherent citations only on owner-terminal allow rows", () => {
    const misplaced = entries
      .filter(([, cites]) => cites.some((cite) => cite.kind === "inherent"))
      .filter(([id]) => ruleById.get(id)?.actor !== "owner-terminal" || ruleById.get(id)?.verdict !== "allow");
    expect(misplaced.map(([id]) => id)).toEqual([]);
  });

  it("gives every deny row a mechanism or a task that will build one", () => {
    const uncovered = entries
      .filter(([id]) => ruleById.get(id)?.verdict === "deny")
      .filter(([, cites]) => !cites.some((cite) => cite.kind === "mechanism" || cite.kind === "task"));
    expect(uncovered.map(([id]) => id)).toEqual([]);
  });
});

describe("enforcementSchema", () => {
  it("rejects a free-text task label in place of a task id", () => {
    expect(enforcementSchema.safeParse({ "MRG-CO": [{ kind: "task", id: "F5-T4" }] }).success).toBe(false);
  });

  it("rejects a row with no citations", () => {
    expect(enforcementSchema.safeParse({ "MRG-CO": [] }).success).toBe(false);
  });
});

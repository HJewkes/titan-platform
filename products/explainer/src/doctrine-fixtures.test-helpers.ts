import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { DoctrineRegistry, DoctrineRule, DoctrineGrade } from "./doctrine-schema.js";
import { RuleRegistrySchema, type RuleRegistry } from "./rules.js";

// Invented rules over invented ledger rows; none is a real doctrine row.

export const VOCABULARY = {
  schema: "doctrine-vocabulary/v1" as const,
  beats: ["hook", "code-walk"],
  types: ["repo-tour", "repo-argument"],
  audiences: ["public-youtube"],
};

export const EVIDENCE_TSV = ["id\tclaim\tgrade", "E01\tWords with pictures\tA", "E02\tA practitioner habit\tC", "E03\tTwo halves\tC (bounds) / D (bands)", "E04\tNo grade yet\t—"].join("\n");

const EVIDENCE: ReadonlyMap<string, readonly DoctrineGrade[]> = new Map<string, DoctrineGrade[]>([
  ["E01", ["A"]],
  ["E02", ["C"]],
  ["E03", ["C", "D"]],
  ["E04", []],
]);

export const craftRule = (overrides: Partial<DoctrineRule> = {}): DoctrineRule => ({
  id: "dir-P1",
  source: { doc: "direction", ref: "P1" },
  text: "Show it as you say it",
  evidence: [],
  scope: { layer: "U" },
  enforcement: ["base"],
  stages: ["build"],
  ...overrides,
});

export const registryWith = (...rules: DoctrineRule[]): DoctrineRegistry => ({ vocabulary: VOCABULARY, evidence: EVIDENCE, rules });

/** Q-V1 is implemented (alias X1); Q-W1 is pending. */
export const Q_RULES: RuleRegistry = RuleRegistrySchema.parse({
  schema: "rules/v1",
  rules: [
    { id: "Q-V1", rule: "No spoken process narration", fields: ["beats.spoken"], aliases: ["X1"], owner_support: "none", l0: { severity: "error", status: "implemented", checks: ["Q-V1"] } },
    { id: "Q-W1", rule: "One why per beat", fields: ["beats.why"], owner_support: "none", l0: { severity: "error", status: "pending", owner: "SQ4" } },
  ],
});

/** Writes a doctrine dir into a fresh temp dir: the fixture vocabulary and ledger, plus `craft` files by name. */
export function writeDoctrineDir(craft: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "doctrine-"));
  mkdirSync(join(dir, "craft"));
  writeFileSync(join(dir, "vocabulary.yaml"), stringify(VOCABULARY));
  writeFileSync(join(dir, "evidence.tsv"), `${EVIDENCE_TSV}\n`);
  for (const [name, body] of Object.entries(craft)) writeFileSync(join(dir, "craft", name), stringify(body));
  return dir;
}

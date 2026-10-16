import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  CraftFileSchema,
  DoctrineRuleSchema,
  DOCTRINE_GRADES,
  DoctrineVocabularySchema,
  type DoctrineRegistry,
  type DoctrineRule,
  type DoctrineGrade,
} from "./doctrine-schema.js";

/** The shipped doctrine dir. src/ and dist/ both sit one level under the package root. */
export const DEFAULT_DOCTRINE_DIR = fileURLToPath(new URL("../doctrine/", import.meta.url));

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads an evidence-ledger TSV: a header row naming `id` and `grade`, then one row per E-id. */
export function parseEvidenceTsv(text: string): Map<string, DoctrineGrade[]> {
  const [header = "", ...rows] = text.split("\n").filter((line) => line.trim() !== "");
  const columns = header.split("\t");
  const idAt = columns.indexOf("id");
  const gradeAt = columns.indexOf("grade");
  if (idAt < 0 || gradeAt < 0) throw new Error("evidence.tsv: the header needs id and grade columns");
  const ledger = new Map<string, DoctrineGrade[]>();
  for (const row of rows) {
    const cells = row.split("\t");
    const grades: string[] = (cells[gradeAt] ?? "").match(/\b[A-D]\b/g) ?? [];
    ledger.set(cells[idAt] ?? "", DOCTRINE_GRADES.filter((grade) => grades.includes(grade)));
  }
  return ledger;
}

function parseCraftRule(file: string, raw: unknown, index: number): DoctrineRule {
  const result = DoctrineRuleSchema.safeParse(raw);
  if (result.success) return result.data;
  const id = typeof raw === "object" && raw !== null && "id" in raw ? String(raw.id) : `#${index}`;
  throw new Error(`${file}: ${id}: ${result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
}

function readCraftFile(path: string, file: string): unknown[] {
  try {
    return CraftFileSchema.parse(parse(readFileSync(path, "utf8"))).rules;
  } catch (error) {
    throw new Error(`${file}: ${describe(error)}`);
  }
}

function loadCraft(dir: string): DoctrineRule[] {
  const craftDir = join(dir, "craft");
  if (!existsSync(craftDir)) return [];
  const files = readdirSync(craftDir).filter((name) => name.endsWith(".yaml")).sort();
  return files.flatMap((name) => {
    const file = `craft/${name}`;
    return readCraftFile(join(craftDir, name), file).map((raw, index) => parseCraftRule(file, raw, index));
  });
}

/**
 * Reads `vocabulary.yaml`, `evidence.tsv` and every `craft/*.yaml` under `dir`, validating each
 * rule's shape. A shape error throws naming the file and rule id; `checkDoctrine` reports the rest.
 */
export function loadDoctrine(dir: string = DEFAULT_DOCTRINE_DIR): DoctrineRegistry {
  const vocabulary = DoctrineVocabularySchema.parse(parse(readFileSync(join(dir, "vocabulary.yaml"), "utf8")));
  const evidence = parseEvidenceTsv(readFileSync(join(dir, "evidence.tsv"), "utf8"));
  return { vocabulary, evidence, rules: loadCraft(dir) };
}

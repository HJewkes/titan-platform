import { diag, type GatherDiagnostic } from "./diagnostics.js";
import type { EvidenceSpan, ExplainerFact } from "./schemas.js";
import { licenseSafe, type FactOptions } from "./summary-facts.js";

export interface DigestFacts {
  facts: ExplainerFact[];
  diagnostics: GatherDiagnostic[];
}

interface DigestFile {
  path: string;
  caption?: string;
}

function digestFiles(files: unknown): DigestFile[] {
  if (!Array.isArray(files)) return [];
  return files.flatMap((file: unknown) => {
    if (typeof file !== "object" || file === null) return [];
    const { path, purpose_one_line: caption } = file as Record<string, unknown>;
    if (typeof path !== "string" || path === "") return [];
    return [{ path, ...(typeof caption === "string" && caption !== "" ? { caption } : {}) }];
  });
}

function parseDigest(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One `shape` fact, `D-<name>`, from a bundle digest: its `summary` as text, each listed file as a
 * file-level span (a digest never bounds lines), and each file's `purpose_one_line` as a caption.
 */
export function digestFacts(name: string, text: string, options: FactOptions = {}): DigestFacts {
  const digest = parseDigest(text);
  const summary = digest?.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    const why = digest === undefined ? "is not a JSON object" : "has no summary";
    return { facts: [], diagnostics: [diag("W-BAD-ROW", `digest ${name} ${why}; skipped`, `digests/${name}.json`)] };
  }
  const files = digestFiles(digest!.files);
  const evidence: EvidenceSpan[] = [...new Set(files.map((file) => file.path))].map((path) => ({ path }));
  const captions = files.flatMap((file) => (file.caption === undefined ? [] : [file.caption]));
  const fact: ExplainerFact = {
    id: `D-${name}`,
    source: "digest",
    kind: "shape",
    text: summary.trim(),
    evidence,
    tier: "digest",
    verified: "yes",
    license_safe: licenseSafe(evidence, options.isLicenseSafe),
    ...(captions.length === 0 ? {} : { captions }),
  };
  return { facts: [fact], diagnostics: [] };
}

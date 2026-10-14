import { z } from "zod";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import type { EvidenceSpan, ExplainerFact } from "./schemas.js";
import { licenseSafe, type FactOptions } from "./summary-facts.js";

interface DigestFacts {
  facts: ExplainerFact[];
  diagnostics: GatherDiagnostic[];
}

// A file entry the digest writer got wrong is skipped rather than failing the whole digest.
const DigestFileSchema = z.object({ path: z.string().min(1), purpose_one_line: z.string().optional() });
const DigestSchema = z.object({ summary: z.unknown(), files: z.array(z.unknown()).catch([]) });
type DigestFile = z.infer<typeof DigestFileSchema>;

function parseDigest(text: string): z.infer<typeof DigestSchema> | undefined {
  try {
    const parsed = DigestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function digestFiles(files: unknown[]): DigestFile[] {
  return files.flatMap((file) => {
    const parsed = DigestFileSchema.safeParse(file);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * One `shape` fact, `D-<name>`, from a bundle digest: its `summary` as text, each listed file as a
 * file-level span (a digest never bounds lines), and each file's `purpose_one_line` as a caption.
 */
export function digestFacts(name: string, text: string, options: FactOptions = {}): DigestFacts {
  const digest = parseDigest(text);
  const summary = digest?.summary;
  if (digest === undefined || typeof summary !== "string" || summary.trim() === "") {
    const why = digest === undefined ? "is not a JSON object" : "has no summary";
    return { facts: [], diagnostics: [diag("W-BAD-ROW", `digest ${name} ${why}; skipped`, `digests/${name}.json`)] };
  }
  const files = digestFiles(digest.files);
  const evidence: EvidenceSpan[] = [...new Set(files.map((file) => file.path))].map((path) => ({ path }));
  const captions = files.flatMap((file) => (file.purpose_one_line ? [file.purpose_one_line] : []));
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

import { z } from "zod";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import type { ExplainerFact, FactKind } from "./schemas.js";
import { licenseSafe, type FactOptions } from "./summary-facts.js";

interface SkimFacts {
  facts: ExplainerFact[];
  diagnostics: GatherDiagnostic[];
}

export const SKIM_FILE = "explainer-skim.json";

// The skim's vocabulary onto the explainer's; a skim kind with no existing meaning gets its own kind.
const SKIM_KINDS: Record<string, FactKind> = {
  purpose: "what-it-is",
  pain: "pain",
  actor: "actor",
  job: "job",
  entry_command: "entry-point",
  non_goal: "should-not",
};

// Loose on purpose: the skim tool owns its file and may add fields; gather reads only these.
const SkimFactSchema = z.object({ kind: z.string(), text: z.string().min(1), quote: z.string().optional(), source: z.string().min(1) });
const SkimSchema = z.looseObject({ facts: z.array(z.unknown()) });
type SkimFact = z.infer<typeof SkimFactSchema>;

function parseSkim(text: string): unknown[] | undefined {
  try {
    const parsed = SkimSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.facts : undefined;
  } catch {
    return undefined;
  }
}

function toFact(fact: SkimFact, kind: FactKind, n: number, options: FactOptions): ExplainerFact {
  const evidence = [{ path: fact.source }];
  return {
    id: `skim/${fact.kind}/${n}`,
    source: "skim",
    kind,
    text: fact.text,
    evidence,
    tier: "skim",
    verified: "docs",
    license_safe: licenseSafe(evidence, options.isLicenseSafe),
    ...(fact.quote === undefined ? {} : { captions: [fact.quote] }),
  };
}

/**
 * Facts from the repo-review skim (`explainer-skim.json`): each quote-checked doc fact cites its
 * source file, carries its quote as a caption, and is numbered per skim kind (`skim/<kind>/<n>`).
 */
export function skimFacts(text: string, options: FactOptions = {}): SkimFacts {
  const entries = parseSkim(text);
  if (entries === undefined) return { facts: [], diagnostics: [diag("W-BAD-ROW", `${SKIM_FILE} has no facts array; skipped`, SKIM_FILE)] };
  const facts: ExplainerFact[] = [];
  const diagnostics: GatherDiagnostic[] = [];
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const parsed = SkimFactSchema.safeParse(entry);
    const kind = parsed.success ? SKIM_KINDS[parsed.data.kind] : undefined;
    if (!parsed.success || kind === undefined) {
      diagnostics.push(diag("W-BAD-ROW", `${SKIM_FILE} fact ${index} has no known kind, text and source; skipped`, `${SKIM_FILE}#facts/${index}`));
      return;
    }
    const n = (seen.get(parsed.data.kind) ?? 0) + 1;
    seen.set(parsed.data.kind, n);
    facts.push(toFact(parsed.data, kind, n, options));
  });
  return { facts, diagnostics };
}

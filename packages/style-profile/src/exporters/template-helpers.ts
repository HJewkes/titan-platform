import { PROFILE_CATEGORIES, type Profile, type Severity } from "../schema/profile.js";
import { severityForConfidence } from "../schema/severity.js";

export interface RuleEntry {
  category: string;
  name: string;
  convention: unknown;
  confidence: number;
  stability?: string;
  description?: string;
  examples?: Array<{ good?: string; bad?: string; source?: string }>;
  extensions?: Record<string, unknown>;
}

export type ExtractedRule = RuleEntry;

export function extractAllRules(profile: Profile): RuleEntry[] {
  const rules: RuleEntry[] = [];

  for (const category of PROFILE_CATEGORIES) {
    const section = profile[category];
    if (!section || typeof section !== "object") continue;

    for (const [name, rule] of Object.entries(section)) {
      if (!rule || typeof rule !== "object") continue;
      rules.push({
        category,
        name,
        convention: rule.convention,
        confidence: rule.confidence,
        stability: rule.stability,
        description: rule.description,
        examples: rule.examples,
        extensions: rule.extensions,
      });
    }
  }

  return rules;
}

export function tierOf(profile: Profile, rule: RuleEntry): Severity {
  return severityForConfidence(rule.confidence, profile.severityThresholds);
}

export function getTopRules(
  profile: Profile,
  count: number = 8,
): RuleEntry[] {
  return extractAllRules(profile)
    .filter((r) => tierOf(profile, r) === "error")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, count);
}

export function getRulesForCategory(
  profile: Profile,
  category: string,
): RuleEntry[] {
  return extractAllRules(profile).filter((r) => r.category === category);
}

export function getRulesByCategory(
  profile: Profile,
): Map<string, RuleEntry[]> {
  const grouped = new Map<string, RuleEntry[]>();
  for (const rule of extractAllRules(profile)) {
    const existing = grouped.get(rule.category) ?? [];
    existing.push(rule);
    grouped.set(rule.category, existing);
  }
  return grouped;
}

const byConfidence = (a: RuleEntry, b: RuleEntry) =>
  b.confidence - a.confidence;

export function getRulesByTier(profile: Profile): {
  critical: RuleEntry[];
  strong: RuleEntry[];
  preferred: RuleEntry[];
} {
  const critical: RuleEntry[] = [];
  const strong: RuleEntry[] = [];
  const preferred: RuleEntry[] = [];
  const buckets: Partial<Record<Severity, RuleEntry[]>> = {
    error: critical,
    warn: strong,
    info: preferred,
  };

  for (const rule of extractAllRules(profile)) {
    buckets[tierOf(profile, rule)]?.push(rule);
  }

  critical.sort(byConfidence);
  strong.sort(byConfidence);
  preferred.sort(byConfidence);

  return { critical, strong, preferred };
}

export function readableConvention(rule: RuleEntry): string {
  if (
    typeof rule.convention === "boolean" ||
    typeof rule.convention === "number"
  ) {
    return rule.description ?? JSON.stringify(rule.convention);
  }
  if (Array.isArray(rule.convention)) {
    return rule.convention.join(" → ");
  }
  return String(rule.convention);
}

export function detectLanguages(profile: Profile): string[] {
  const langs: string[] = [];
  const hasTypescriptSignals =
    Object.keys(profile.naming).length > 0 ||
    Object.keys(profile.structure).length > 0;
  if (hasTypescriptSignals) langs.push("typescript");
  return langs.length > 0 ? langs : ["typescript"];
}

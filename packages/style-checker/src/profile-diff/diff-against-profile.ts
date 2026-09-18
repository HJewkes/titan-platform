import { PROFILE_CATEGORIES } from "@titan-design/style-profile";
import type { Profile, ProfileCategory } from "@titan-design/style-profile";
import type { Observation } from "@titan-design/style-analyzer";

export interface Deviation {
  file: string;
  line: number;
  rule: string;
  expected: string;
  found: string;
  severity: "error" | "warn" | "info";
}

export interface DiffResult {
  deviations: Deviation[];
  summary: {
    total: number;
    matching: number;
    deviating: number;
  };
}

function getSeverity(
  confidence: number,
  thresholds: Profile["severityThresholds"],
): "error" | "warn" | "info" {
  if (confidence >= thresholds.error) return "error";
  if (confidence >= thresholds.warn) return "warn";
  return "info";
}

function resolveProfileRule(
  profile: Profile,
  observationType: string,
): { convention: unknown; confidence: number } | undefined {
  const [category, rule] = observationType.split(".");
  if (!PROFILE_CATEGORIES.includes(category as ProfileCategory)) return undefined;
  const section = profile[category as ProfileCategory];
  if (!section || typeof section !== "object") return undefined;
  const ruleObj = rule === undefined ? undefined : section[rule];
  if (!ruleObj || typeof ruleObj !== "object") return undefined;
  if (ruleObj.convention === undefined || ruleObj.confidence === undefined) {
    return undefined;
  }
  return { convention: ruleObj.convention, confidence: ruleObj.confidence };
}

export function diffAgainstProfile(
  profile: Profile,
  observations: Observation[],
): DiffResult {
  const deviations: Deviation[] = [];
  let matching = 0;

  for (const obs of observations) {
    const profileRule = resolveProfileRule(profile, obs.type);
    if (!profileRule) continue;

    const expected = String(profileRule.convention);
    const found = String(obs.value);

    if (found === expected) {
      matching++;
    } else {
      deviations.push({
        file: obs.file,
        line: obs.line,
        rule: obs.type,
        expected,
        found,
        severity: getSeverity(
          profileRule.confidence,
          profile.severityThresholds,
        ),
      });
    }
  }

  return {
    deviations,
    summary: {
      total: observations.length,
      matching,
      deviating: deviations.length,
    },
  };
}

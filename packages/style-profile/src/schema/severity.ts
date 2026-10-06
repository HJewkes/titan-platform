import {
  DEFAULT_SEVERITY_THRESHOLDS,
  type Severity,
  type SeverityThresholds,
} from "./profile.js";

export type EslintSeverity = "error" | "warn" | "off";

/** The one confidence ladder: a rule's profile tier, "off" below the info threshold. */
export function severityForConfidence(
  confidence: number,
  thresholds: SeverityThresholds = DEFAULT_SEVERITY_THRESHOLDS,
): Severity {
  if (confidence >= thresholds.error) return "error";
  if (confidence >= thresholds.warn) return "warn";
  if (confidence >= thresholds.info) return "info";
  return "off";
}

// ESLint rejects "info" as a rule level, so the profile's info tier still lints, as a warning.
export function toEslintLevel(severity: Severity): EslintSeverity {
  return severity === "info" ? "warn" : severity;
}

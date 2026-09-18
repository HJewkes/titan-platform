import type { Severity, SeverityThresholds } from "@titan-design/style-profile";
import { DEFAULT_SEVERITY_THRESHOLDS } from "@titan-design/style-profile";
import type { Stability } from "./stability.js";

export type { Severity, SeverityThresholds };
export { DEFAULT_SEVERITY_THRESHOLDS };

export interface StabilityWeights {
  high: number;
  medium: number;
  low: number;
}

export const DEFAULT_STABILITY_WEIGHTS: StabilityWeights = {
  high: 1.0,
  medium: 0.85,
  low: 0.7,
};

export function computeConfidence(
  consistency: number,
  stability: Stability,
  weights: StabilityWeights = DEFAULT_STABILITY_WEIGHTS,
): number {
  return Math.min(1.0, consistency * weights[stability]);
}

export function mapSeverity(
  confidence: number,
  thresholds: SeverityThresholds = DEFAULT_SEVERITY_THRESHOLDS,
): Severity {
  if (confidence >= thresholds.error) return "error";
  if (confidence >= thresholds.warn) return "warn";
  if (confidence >= thresholds.info) return "info";
  return "off";
}

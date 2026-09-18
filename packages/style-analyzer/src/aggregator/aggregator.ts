import type { Observation, ObservationCategory } from "../extractors/types.js";
import {
  computeConfidence,
  mapSeverity,
  DEFAULT_STABILITY_WEIGHTS,
  DEFAULT_SEVERITY_THRESHOLDS,
  type StabilityWeights,
  type SeverityThresholds,
  type Severity,
} from "./confidence.js";
import {
  groupByType,
  computeDistribution,
  selectExamples,
  type FrequencyDistribution,
} from "./frequency.js";
import { lookupStability, type Stability } from "./stability.js";

export { computeConfidence, mapSeverity } from "./confidence.js";
export { lookupStability, type Stability } from "./stability.js";
export type { FrequencyDistribution } from "./frequency.js";
export type { Severity } from "@titan-design/style-profile";
export type {
  StabilityWeights,
  SeverityThresholds,
} from "./confidence.js";

export interface AggregatedFeature {
  type: string;
  category: ObservationCategory;
  convention: string | number | boolean | string[];
  distribution: FrequencyDistribution;
  confidence: number;
  stability: Stability;
  severity: Severity;
  needsReview: boolean;
  examples: Observation[];
}

export interface AggregatorConfig {
  stabilityWeights?: StabilityWeights;
  severityThresholds?: SeverityThresholds;
  reviewThreshold?: number;
  maxExamples?: number;
}

export interface AggregatorResult {
  features: Map<string, AggregatedFeature>;
  reviewQueue: AggregatedFeature[];
  summary: {
    totalObservations: number;
    totalFeatures: number;
    avgConfidence: number;
    featuresNeedingReview: number;
  };
}

export class Aggregator {
  private stabilityWeights: StabilityWeights;
  private severityThresholds: SeverityThresholds;
  private reviewThreshold: number;
  private maxExamples: number;

  constructor(config?: AggregatorConfig) {
    this.stabilityWeights =
      config?.stabilityWeights ?? DEFAULT_STABILITY_WEIGHTS;
    this.severityThresholds =
      config?.severityThresholds ?? DEFAULT_SEVERITY_THRESHOLDS;
    this.reviewThreshold = config?.reviewThreshold ?? 0.6;
    this.maxExamples = config?.maxExamples ?? 5;
  }

  aggregate(observations: Observation[]): AggregatorResult {
    const grouped = groupByType(observations);
    const features = new Map<string, AggregatedFeature>();
    const reviewQueue: AggregatedFeature[] = [];

    for (const [type, typeObservations] of grouped) {
      const feature = this.buildFeature(type, typeObservations);

      features.set(type, feature);

      if (feature.needsReview) {
        reviewQueue.push(feature);
      }
    }

    reviewQueue.sort((a, b) => a.confidence - b.confidence);

    return {
      features,
      reviewQueue,
      summary: {
        totalObservations: observations.length,
        totalFeatures: features.size,
        avgConfidence: averageConfidence(features),
        featuresNeedingReview: reviewQueue.length,
      },
    };
  }

  private buildFeature(
    type: string,
    typeObservations: Observation[],
  ): AggregatedFeature {
    const distribution = computeDistribution(typeObservations);
    const stability = lookupStability(type);
    const confidence = computeConfidence(
      distribution.consistency,
      stability,
      this.stabilityWeights,
    );

    return {
      type,
      category: this.extractCategory(type),
      convention: distribution.dominant,
      distribution,
      confidence,
      stability,
      severity: mapSeverity(confidence, this.severityThresholds),
      needsReview: confidence < this.reviewThreshold,
      examples: selectExamples(typeObservations, this.maxExamples),
    };
  }

  private extractCategory(type: string): ObservationCategory {
    const dotIndex = type.indexOf(".");
    return (dotIndex > 0 ? type.substring(0, dotIndex) : type) as ObservationCategory;
  }
}

function averageConfidence(features: Map<string, AggregatedFeature>): number {
  const confidences = Array.from(features.values()).map((f) => f.confidence);
  return confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;
}

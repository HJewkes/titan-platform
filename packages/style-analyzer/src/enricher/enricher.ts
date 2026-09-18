import type { AggregatedFeature } from "../aggregator/aggregator.js";
import { LlmRunner, type LlmJob } from "./llm-runner.js";
import type { LlmMessage, LlmProvider } from "./llm.js";
import {
  getPromptForFeature,
  needsAiEnrichment,
  type PromptInput,
} from "./prompts.js";

export { needsAiEnrichment, AI_ENRICHED_FEATURES } from "./prompts.js";
export type { LlmProvider, LlmMessage, LlmResponse } from "./llm.js";

export type { AggregatedFeature } from "../aggregator/aggregator.js";

export interface EnrichmentEntry {
  featureType: string;
  description: string;
  tokensUsed: number;
}

export interface EnrichmentError {
  featureType: string;
  error: string;
}

export interface EnrichmentResult {
  enriched: Map<string, EnrichmentEntry>;
  errors: EnrichmentError[];
  totalTokensUsed: number;
  budgetExceeded: boolean;
  skipped: boolean;
}

export interface EnricherConfig {
  provider: LlmProvider;
  enabled?: boolean;
  totalTokenBudget?: number;
}

export class Enricher {
  private runner: LlmRunner;
  private enabled: boolean;

  constructor(config: EnricherConfig) {
    this.runner = new LlmRunner({
      provider: config.provider,
      totalTokenBudget: config.totalTokenBudget,
    });
    this.enabled = config.enabled ?? true;
  }

  async enrich(
    features: Map<string, AggregatedFeature>,
  ): Promise<EnrichmentResult> {
    if (!this.enabled) {
      return {
        enriched: new Map(),
        errors: [],
        totalTokensUsed: 0,
        budgetExceeded: false,
        skipped: true,
      };
    }

    const jobs: LlmJob<string>[] = [];
    for (const [type, feature] of features) {
      if (!needsAiEnrichment(type)) continue;
      const promptTemplate = getPromptForFeature(type);
      if (!promptTemplate) continue;

      const input = this.buildPromptInput(type, feature);
      const messages: LlmMessage[] = [
        { role: "system", content: promptTemplate.system },
        {
          role: "user",
          content: promptTemplate.buildUserMessage(input),
        },
      ];

      jobs.push({ key: type, messages, maxTokens: promptTemplate.maxTokens });
    }

    const runResult = await this.runner.run(jobs);

    const enriched = new Map<string, EnrichmentEntry>();
    for (const r of runResult.results) {
      enriched.set(r.key, {
        featureType: r.key,
        description: r.content,
        tokensUsed: r.tokensUsed,
      });
    }

    return {
      enriched,
      errors: runResult.errors.map((e) => ({
        featureType: e.key,
        error: e.error,
      })),
      totalTokensUsed: runResult.totalTokensUsed,
      budgetExceeded: runResult.budgetExceeded,
      skipped: false,
    };
  }

  private buildPromptInput(
    type: string,
    feature: AggregatedFeature,
  ): PromptInput {
    const distributionRecord: Record<string, number> = {};
    for (const [key, count] of feature.distribution.values) {
      distributionRecord[String(key)] = count;
    }

    const exampleTexts = feature.examples.map((obs) => {
      if (typeof obs.value === "string") return obs.value;
      return JSON.stringify(obs.value);
    });

    return {
      category: feature.category,
      featureType: type,
      convention: feature.convention,
      confidence: feature.confidence,
      consistency: feature.distribution.consistency,
      examples: exampleTexts,
      distribution: distributionRecord,
    };
  }
}

import type { LlmMessage, LlmProvider } from "./llm.js";

export interface LlmJob<TKey> {
  key: TKey;
  messages: LlmMessage[];
  maxTokens: number;
}

export interface LlmJobSuccess<TKey> {
  key: TKey;
  content: string;
  tokensUsed: number;
}

export interface LlmJobFailure<TKey> {
  key: TKey;
  error: string;
}

export interface LlmRunResult<TKey> {
  results: LlmJobSuccess<TKey>[];
  errors: LlmJobFailure<TKey>[];
  totalTokensUsed: number;
  budgetExceeded: boolean;
}

export interface LlmRunnerConfig {
  provider: LlmProvider;
  totalTokenBudget?: number;
}

/**
 * Runs a list of LLM jobs sequentially against a provider, halting when the
 * cumulative token budget is exceeded and capturing per-job errors instead
 * of throwing. Knows nothing about features, prompts, or domain shapes —
 * callers build jobs upstream.
 */
export class LlmRunner {
  private provider: LlmProvider;
  private totalTokenBudget: number;

  constructor(config: LlmRunnerConfig) {
    this.provider = config.provider;
    this.totalTokenBudget = config.totalTokenBudget ?? 20_000;
  }

  async run<TKey>(jobs: LlmJob<TKey>[]): Promise<LlmRunResult<TKey>> {
    const results: LlmJobSuccess<TKey>[] = [];
    const errors: LlmJobFailure<TKey>[] = [];
    let totalTokensUsed = 0;
    let budgetExceeded = false;

    for (const job of jobs) {
      if (totalTokensUsed >= this.totalTokenBudget) {
        budgetExceeded = true;
        break;
      }

      try {
        const response = await this.provider.generate(job.messages, {
          maxTokens: job.maxTokens,
        });
        results.push({
          key: job.key,
          content: response.content,
          tokensUsed: response.tokensUsed,
        });
        totalTokensUsed += response.tokensUsed;
      } catch (error) {
        errors.push({
          key: job.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { results, errors, totalTokensUsed, budgetExceeded };
  }
}

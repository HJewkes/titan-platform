import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmProvider, LlmResponse } from "./llm.js";
import { Enricher, type AggregatedFeature } from "./enricher.js";
import type { ObservationCategory } from "../extractors/types.js";

function createMockProvider(
  response: string = "Generated description.",
): LlmProvider {
  return {
    name: "mock",
    generate: vi.fn().mockResolvedValue({
      content: response,
      tokensUsed: 150,
    } satisfies LlmResponse),
  };
}

function makeFeature(
  overrides: Partial<AggregatedFeature> & Pick<AggregatedFeature, "type">,
): AggregatedFeature {
  return {
    category: overrides.type.split(".")[0] as ObservationCategory,
    convention: "some-pattern",
    distribution: {
      values: new Map([["some-pattern", 10]]),
      total: 10,
      dominant: "some-pattern",
      consistency: 1.0,
    },
    confidence: 0.85,
    stability: "high",
    severity: "error",
    needsReview: false,
    examples: [],
    ...overrides,
  };
}

describe("Enricher", () => {
  let mockProvider: LlmProvider;

  beforeEach(() => {
    mockProvider = createMockProvider();
  });

  describe("feature filtering", () => {
    it("only enriches features that need AI (9 of 85)", async () => {
      const enricher = new Enricher({ provider: mockProvider });

      const features = new Map<string, AggregatedFeature>([
        ["naming.variables", makeFeature({ type: "naming.variables" })],
        ["documentation.voice", makeFeature({ type: "documentation.voice" })],
        ["formatting.semicolons", makeFeature({ type: "formatting.semicolons" })],
        ["reviewVoice.tone", makeFeature({ type: "reviewVoice.tone" })],
      ]);

      const result = await enricher.enrich(features);

      expect(mockProvider.generate).toHaveBeenCalledTimes(2);
      expect(result.enriched.has("documentation.voice")).toBe(true);
      expect(result.enriched.has("reviewVoice.tone")).toBe(true);
      expect(result.enriched.has("naming.variables")).toBe(false);
      expect(result.enriched.has("formatting.semicolons")).toBe(false);
    });

    it("returns empty enrichments when no features need AI", async () => {
      const enricher = new Enricher({ provider: mockProvider });

      const features = new Map<string, AggregatedFeature>([
        ["naming.variables", makeFeature({ type: "naming.variables" })],
        ["formatting.semicolons", makeFeature({ type: "formatting.semicolons" })],
      ]);

      const result = await enricher.enrich(features);

      expect(mockProvider.generate).not.toHaveBeenCalled();
      expect(result.enriched.size).toBe(0);
    });
  });

  describe("prompt construction", () => {
    it("passes summarized statistics to the prompt, not raw code", async () => {
      const enricher = new Enricher({ provider: mockProvider });

      const features = new Map<string, AggregatedFeature>([
        [
          "documentation.voice",
          makeFeature({
            type: "documentation.voice",
            convention: "imperative",
            confidence: 0.72,
            examples: [
              { type: "documentation.voice", category: "documentation", value: "imperative", file: "test.ts", line: 1 },
            ],
          }),
        ],
      ]);

      await enricher.enrich(features);

      const generateCall = (mockProvider.generate as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const messages = generateCall![0];
      const userMessage = messages.find(
        (m: { role: string }) => m.role === "user",
      );

      expect(userMessage.content).toContain("documentation.voice");
      expect(userMessage.content).toContain("imperative");
      expect(userMessage.content).toContain("72%");
    });
  });

  describe("enrichment result", () => {
    it("stores generated description in enrichment map", async () => {
      const mockResponse =
        "Prefers imperative voice in documentation comments.";
      const provider = createMockProvider(mockResponse);
      const enricher = new Enricher({ provider });

      const features = new Map<string, AggregatedFeature>([
        [
          "documentation.voice",
          makeFeature({ type: "documentation.voice" }),
        ],
      ]);

      const result = await enricher.enrich(features);

      expect(
        result.enriched.get("documentation.voice")?.description,
      ).toBe(mockResponse);
    });

    it("tracks total tokens used", async () => {
      const enricher = new Enricher({ provider: mockProvider });

      const features = new Map<string, AggregatedFeature>([
        [
          "documentation.voice",
          makeFeature({ type: "documentation.voice" }),
        ],
        ["reviewVoice.tone", makeFeature({ type: "reviewVoice.tone" })],
      ]);

      const result = await enricher.enrich(features);

      expect(result.totalTokensUsed).toBe(300);
    });
  });

  describe("error handling", () => {
    it("continues enriching other features when one fails", async () => {
      const failingProvider: LlmProvider = {
        name: "failing",
        generate: vi
          .fn()
          .mockRejectedValueOnce(new Error("API error"))
          .mockResolvedValueOnce({
            content: "Success",
            tokensUsed: 100,
          }),
      };
      const enricher = new Enricher({ provider: failingProvider });

      const features = new Map<string, AggregatedFeature>([
        [
          "documentation.voice",
          makeFeature({ type: "documentation.voice" }),
        ],
        ["reviewVoice.tone", makeFeature({ type: "reviewVoice.tone" })],
      ]);

      const result = await enricher.enrich(features);

      expect(result.enriched.has("reviewVoice.tone")).toBe(true);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]!.featureType).toBe("documentation.voice");
    });

    it("reports all errors without throwing", async () => {
      const failingProvider: LlmProvider = {
        name: "failing",
        generate: vi.fn().mockRejectedValue(new Error("API error")),
      };
      const enricher = new Enricher({ provider: failingProvider });

      const features = new Map<string, AggregatedFeature>([
        [
          "documentation.voice",
          makeFeature({ type: "documentation.voice" }),
        ],
      ]);

      const result = await enricher.enrich(features);

      expect(result.errors.length).toBe(1);
      expect(result.enriched.size).toBe(0);
    });
  });

  describe("token budget", () => {
    it("respects per-category token limit in options", async () => {
      const enricher = new Enricher({ provider: mockProvider });

      const features = new Map<string, AggregatedFeature>([
        [
          "documentation.voice",
          makeFeature({ type: "documentation.voice" }),
        ],
      ]);

      await enricher.enrich(features);

      const generateCall = (mockProvider.generate as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      const options = generateCall![1];
      expect(options.maxTokens).toBeLessThanOrEqual(400);
    });

    it("stops enriching when total budget is exceeded", async () => {
      const expensiveProvider: LlmProvider = {
        name: "expensive",
        generate: vi.fn().mockResolvedValue({
          content: "Description",
          tokensUsed: 15000,
        }),
      };
      const enricher = new Enricher({
        provider: expensiveProvider,
        totalTokenBudget: 20000,
      });

      const features = new Map<string, AggregatedFeature>([
        [
          "documentation.voice",
          makeFeature({ type: "documentation.voice" }),
        ],
        [
          "documentation.whyVsWhat",
          makeFeature({ type: "documentation.whyVsWhat" }),
        ],
        ["reviewVoice.tone", makeFeature({ type: "reviewVoice.tone" })],
      ]);

      const result = await enricher.enrich(features);

      expect(expensiveProvider.generate).toHaveBeenCalledTimes(2);
      expect(result.budgetExceeded).toBe(true);
    });
  });

  describe("skip mode (--no-ai flag)", () => {
    it("returns empty results when disabled", async () => {
      const enricher = new Enricher({
        provider: mockProvider,
        enabled: false,
      });

      const features = new Map<string, AggregatedFeature>([
        [
          "documentation.voice",
          makeFeature({ type: "documentation.voice" }),
        ],
      ]);

      const result = await enricher.enrich(features);

      expect(mockProvider.generate).not.toHaveBeenCalled();
      expect(result.enriched.size).toBe(0);
      expect(result.skipped).toBe(true);
    });
  });
});

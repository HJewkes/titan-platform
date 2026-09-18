import { describe, it, expect } from "vitest";
import { Aggregator } from "./aggregator.js";
import type { Observation, ObservationCategory } from "../extractors/types.js";

function makeObservation(
  overrides: Partial<Observation> & Pick<Observation, "type" | "value">,
): Observation {
  const type = overrides.type;
  const category =
    overrides.category ??
    ((type.indexOf(".") > 0 ? type.substring(0, type.indexOf(".")) : type) as ObservationCategory);

  return {
    file: "test.ts",
    line: 1,
    category,
    ...overrides,
  };
}

describe("Aggregator", () => {
  const aggregator = new Aggregator();

  describe("frequency distribution", () => {
    it("computes dominant value from observations", () => {
      const observations: Observation[] = [
        makeObservation({ type: "naming.variable", value: "camelCase" }),
        makeObservation({ type: "naming.variable", value: "camelCase" }),
        makeObservation({ type: "naming.variable", value: "camelCase" }),
        makeObservation({ type: "naming.variable", value: "snake_case" }),
        makeObservation({ type: "naming.variable", value: "snake_case" }),
      ];

      const result = aggregator.aggregate(observations);
      const feature = result.features.get("naming.variable");

      expect(feature).toBeDefined();
      expect(feature!.convention).toBe("camelCase");
      expect(feature!.distribution.consistency).toBeCloseTo(0.6, 1);
    });

    it("computes distribution percentages correctly", () => {
      const observations: Observation[] = [
        makeObservation({ type: "formatting.quoteStyle", value: "single" }),
        makeObservation({ type: "formatting.quoteStyle", value: "single" }),
        makeObservation({ type: "formatting.quoteStyle", value: "single" }),
        makeObservation({ type: "formatting.quoteStyle", value: "double" }),
      ];

      const result = aggregator.aggregate(observations);
      const feature = result.features.get("formatting.quoteStyle");

      expect(feature!.distribution.values.get("single")).toBe(3);
      expect(feature!.distribution.values.get("double")).toBe(1);
      expect(feature!.distribution.total).toBe(4);
      expect(feature!.distribution.consistency).toBeCloseTo(0.75, 2);
    });
  });

  describe("confidence scoring", () => {
    it("applies high stability weight (1.0) for naming.variable", () => {
      const observations: Observation[] = Array.from({ length: 10 }, () =>
        makeObservation({ type: "naming.variable", value: "camelCase" }),
      );

      const result = aggregator.aggregate(observations);
      const feature = result.features.get("naming.variable");

      expect(feature!.confidence).toBeCloseTo(1.0, 2);
      expect(feature!.stability).toBe("high");
    });

    it("applies medium stability weight (0.85) for naming.boolean", () => {
      const observations: Observation[] = Array.from({ length: 10 }, () =>
        makeObservation({ type: "naming.boolean", value: "is-prefix" }),
      );

      const result = aggregator.aggregate(observations);
      const feature = result.features.get("naming.boolean");

      expect(feature!.confidence).toBeCloseTo(0.85, 2);
      expect(feature!.stability).toBe("medium");
    });

    it("reduces confidence when consistency is low", () => {
      const observations: Observation[] = [
        makeObservation({ type: "naming.variable", value: "camelCase" }),
        makeObservation({ type: "naming.variable", value: "camelCase" }),
        makeObservation({ type: "naming.variable", value: "snake_case" }),
        makeObservation({ type: "naming.variable", value: "PascalCase" }),
        makeObservation({ type: "naming.variable", value: "kebab-case" }),
      ];

      const result = aggregator.aggregate(observations);
      const feature = result.features.get("naming.variable");

      expect(feature!.confidence).toBeCloseTo(0.4, 2);
    });
  });

  describe("severity mapping", () => {
    it("maps high confidence to error severity", () => {
      const observations: Observation[] = Array.from({ length: 20 }, () =>
        makeObservation({ type: "naming.variable", value: "camelCase" }),
      );

      const result = aggregator.aggregate(observations);
      expect(result.features.get("naming.variable")!.severity).toBe("error");
    });

    it("maps medium confidence to warn severity", () => {
      const observations: Observation[] = [
        ...Array.from({ length: 7 }, () =>
          makeObservation({ type: "naming.variable", value: "camelCase" }),
        ),
        ...Array.from({ length: 3 }, () =>
          makeObservation({ type: "naming.variable", value: "snake_case" }),
        ),
      ];

      const result = aggregator.aggregate(observations);
      expect(result.features.get("naming.variable")!.severity).toBe("warn");
    });

    it("maps low confidence to info severity", () => {
      const observations: Observation[] = [
        ...Array.from({ length: 5 }, () =>
          makeObservation({ type: "naming.variable", value: "camelCase" }),
        ),
        ...Array.from({ length: 5 }, () =>
          makeObservation({ type: "naming.variable", value: "snake_case" }),
        ),
      ];

      const result = aggregator.aggregate(observations);
      expect(result.features.get("naming.variable")!.severity).toBe("info");
    });

    it("maps very low confidence to off severity", () => {
      const observations: Observation[] = [
        makeObservation({ type: "naming.parameter", value: "a" }),
        makeObservation({ type: "naming.parameter", value: "b" }),
        makeObservation({ type: "naming.parameter", value: "c" }),
      ];

      const result = aggregator.aggregate(observations);
      expect(result.features.get("naming.parameter")!.severity).toBe(
        "off",
      );
    });
  });

  describe("review flagging", () => {
    it("flags low-confidence features for review", () => {
      const observations: Observation[] = [
        ...Array.from({ length: 5 }, () =>
          makeObservation({ type: "naming.variable", value: "camelCase" }),
        ),
        ...Array.from({ length: 5 }, () =>
          makeObservation({ type: "naming.variable", value: "snake_case" }),
        ),
      ];

      const result = aggregator.aggregate(observations);
      const feature = result.features.get("naming.variable");

      expect(feature!.needsReview).toBe(true);
      expect(result.reviewQueue).toContainEqual(
        expect.objectContaining({ type: "naming.variable" }),
      );
    });

    it("does not flag high-confidence features for review", () => {
      const observations: Observation[] = Array.from({ length: 20 }, () =>
        makeObservation({ type: "naming.variable", value: "camelCase" }),
      );

      const result = aggregator.aggregate(observations);
      expect(result.features.get("naming.variable")!.needsReview).toBe(false);
    });

    it("sorts review queue by confidence ascending", () => {
      const observations: Observation[] = [
        ...Array.from({ length: 3 }, () =>
          makeObservation({ type: "naming.variable", value: "camelCase" }),
        ),
        ...Array.from({ length: 3 }, () =>
          makeObservation({ type: "naming.variable", value: "snake_case" }),
        ),
        ...Array.from({ length: 2 }, () =>
          makeObservation({ type: "naming.parameter", value: "x" }),
        ),
        makeObservation({ type: "naming.parameter", value: "y" }),
      ];

      const result = aggregator.aggregate(observations);

      if (result.reviewQueue.length >= 2) {
        for (let i = 1; i < result.reviewQueue.length; i++) {
          expect(result.reviewQueue[i]!.confidence).toBeGreaterThanOrEqual(
            result.reviewQueue[i - 1]!.confidence,
          );
        }
      }
    });
  });

  describe("grouping", () => {
    it("groups observations by type and extracts category", () => {
      const observations: Observation[] = [
        makeObservation({ type: "naming.variable", value: "camelCase" }),
        makeObservation({ type: "naming.function", value: "camelCase" }),
        makeObservation({ type: "formatting.semicolons", value: true }),
      ];

      const result = aggregator.aggregate(observations);

      expect(result.features.size).toBe(3);
      expect(result.features.get("naming.variable")!.category).toBe("naming");
      expect(result.features.get("formatting.semicolons")!.category).toBe(
        "formatting",
      );
    });
  });

  describe("summary statistics", () => {
    it("computes correct totals", () => {
      const observations: Observation[] = [
        makeObservation({ type: "naming.variable", value: "camelCase" }),
        makeObservation({ type: "naming.variable", value: "camelCase" }),
        makeObservation({ type: "formatting.semicolons", value: true }),
      ];

      const result = aggregator.aggregate(observations);

      expect(result.summary.totalObservations).toBe(3);
      expect(result.summary.totalFeatures).toBe(2);
      expect(result.summary.avgConfidence).toBeGreaterThan(0);
    });
  });

  describe("examples", () => {
    it("keeps representative observations as examples (max 5)", () => {
      const observations: Observation[] = Array.from(
        { length: 10 },
        (_, i) =>
          makeObservation({
            type: "naming.variable",
            value: "camelCase",
            file: `file${i}.ts`,
            line: i + 1,
          }),
      );

      const result = aggregator.aggregate(observations);
      const feature = result.features.get("naming.variable");

      expect(feature!.examples.length).toBeLessThanOrEqual(5);
      expect(feature!.examples.length).toBeGreaterThan(0);
    });
  });

  describe("unknown types", () => {
    it("aggregates unknown observation types with medium stability", () => {
      const observations: Observation[] = Array.from({ length: 10 }, () =>
        makeObservation({ type: "future.newFeature", value: "something" }),
      );

      const result = aggregator.aggregate(observations);
      const feature = result.features.get("future.newFeature");

      expect(feature).toBeDefined();
      expect(feature!.stability).toBe("medium");
      expect(feature!.confidence).toBeCloseTo(0.85, 2);
    });
  });

  describe("custom config", () => {
    it("accepts custom severity thresholds", () => {
      const strictAggregator = new Aggregator({
        severityThresholds: {
          error: 0.95,
          warn: 0.8,
          info: 0.6,
        },
      });

      const observations: Observation[] = [
        ...Array.from({ length: 10 }, () =>
          makeObservation({ type: "naming.variable", value: "camelCase" }),
        ),
        makeObservation({ type: "naming.variable", value: "snake_case" }),
      ];

      const result = strictAggregator.aggregate(observations);
      const feature = result.features.get("naming.variable");

      expect(feature!.severity).toBe("warn");
    });

    it("accepts custom stability weights", () => {
      const customAggregator = new Aggregator({
        stabilityWeights: { high: 1.0, medium: 0.9, low: 0.8 },
      });

      const observations: Observation[] = Array.from({ length: 10 }, () =>
        makeObservation({ type: "naming.boolean", value: "is-prefix" }),
      );

      const result = customAggregator.aggregate(observations);
      expect(
        result.features.get("naming.boolean")!.confidence,
      ).toBeCloseTo(0.9, 2);
    });
  });
});

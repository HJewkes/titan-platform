import { describe, it, expect } from "vitest";
import { ReviewVoiceExtractor } from "./review-voice.js";

describe("ReviewVoiceExtractor", () => {
  const extractor = new ReviewVoiceExtractor();

  const sampleComments = [
    { body: "This function name is not descriptive enough.", file: "src/utils.ts" },
    { body: "Missing error handling here. What happens if the API call fails?", file: "src/api.ts" },
    { body: "This is getting complex. Can we extract this into smaller functions?", file: "src/processor.ts" },
    { body: "Nit: inconsistent naming. We use camelCase everywhere else.", file: "src/helpers.ts" },
    { body: "This could be more performant. Consider memoizing.", file: "src/compute.ts" },
    { body: "Please add error handling for null input.", file: "src/parser.ts" },
    { body: "The naming here is confusing.", file: "src/math.ts" },
    { body: "Style: prefer single quotes for consistency.", file: "src/config.ts" },
    { body: "This function is too long. Split it up.", file: "src/handler.ts" },
    { body: "Performance concern: this re-renders on every change.", file: "src/component.tsx" },
    { body: "Naming: prefer isEnabled over enabled for booleans.", file: "src/flags.ts" },
    { body: "Good use of early return pattern here.", file: "src/auth.ts" },
  ];

  describe("topic categorization", () => {
    it("categorizes comments into review topics", () => {
      const observations = extractor.extractFromComments(sampleComments);

      const topicObs = observations.filter(
        (o) => o.type === "reviewVoice.topicFrequency",
      );

      expect(topicObs.length).toBeGreaterThan(0);

      const topics = topicObs.map((o) => o.value);
      expect(topics).toContain("naming");
      expect(topics).toContain("error-handling");
      expect(topics).toContain("complexity");
    });

    it("counts frequency of each topic", () => {
      const observations = extractor.extractFromComments(sampleComments);

      const namingObs = observations.find(
        (o) =>
          o.type === "reviewVoice.topicFrequency" && o.value === "naming",
      );
      expect(namingObs).toBeDefined();
      expect(namingObs!.metadata?.count as number).toBeGreaterThanOrEqual(3);

      const errorObs = observations.find(
        (o) =>
          o.type === "reviewVoice.topicFrequency" &&
          o.value === "error-handling",
      );
      expect(errorObs).toBeDefined();
      expect(errorObs!.metadata?.count as number).toBeGreaterThanOrEqual(2);
    });

    it("includes ratio of topic to total comments", () => {
      const observations = extractor.extractFromComments(sampleComments);

      const topicObs = observations.filter(
        (o) => o.type === "reviewVoice.topicFrequency",
      );

      for (const obs of topicObs) {
        expect(obs.metadata?.ratio as number).toBeGreaterThan(0);
        expect(obs.metadata?.ratio as number).toBeLessThanOrEqual(1);
        expect(obs.metadata?.total).toBe(sampleComments.length);
      }
    });

    it("includes example comments for each topic", () => {
      const observations = extractor.extractFromComments(sampleComments);

      const topicObs = observations.filter(
        (o) => o.type === "reviewVoice.topicFrequency",
      );

      for (const obs of topicObs) {
        const examples = obs.metadata?.examples as string[];
        expect(examples).toBeDefined();
        expect(Array.isArray(examples)).toBe(true);
        expect(examples.length).toBeGreaterThan(0);
        expect(examples.length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe("keyword extraction", () => {
    it("extracts frequently mentioned keywords", () => {
      const observations = extractor.extractFromComments(sampleComments);

      const keywordObs = observations.filter(
        (o) => o.type === "reviewVoice.keyword",
      );

      expect(keywordObs.length).toBeGreaterThan(0);
      for (const obs of keywordObs) {
        expect(obs.metadata?.count as number).toBeGreaterThanOrEqual(1);
      }
    });

    it("detects early-return keyword", () => {
      const observations = extractor.extractFromComments(sampleComments);

      const earlyReturn = observations.find(
        (o) => o.type === "reviewVoice.keyword" && o.value === "early-return",
      );
      expect(earlyReturn).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("handles empty comment list", () => {
      const observations = extractor.extractFromComments([]);
      expect(observations).toEqual([]);
    });

    it("handles comments with no recognizable topics", () => {
      const observations = extractor.extractFromComments([
        { body: "LGTM", file: "src/foo.ts" },
        { body: "Looks good to me!", file: "src/bar.ts" },
      ]);

      const topicObs = observations.filter(
        (o) => o.type === "reviewVoice.topicFrequency",
      );
      expect(topicObs.length).toBeLessThanOrEqual(1);
    });

    it("handles single-word comments gracefully", () => {
      const observations = extractor.extractFromComments([
        { body: "Nit", file: "src/foo.ts" },
      ]);
      expect(observations).toBeDefined();
    });
  });

  describe("Extractor interface", () => {
    it("has correct name", () => {
      expect(extractor.name).toBe("reviewVoice");
    });

    it("implements extract()", () => {
      expect(typeof extractor.extract).toBe("function");
    });
  });
});

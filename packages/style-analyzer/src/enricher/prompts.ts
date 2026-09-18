export interface PromptInput {
  category: string;
  featureType: string;
  convention: string | number | boolean | string[];
  confidence: number;
  consistency: number;
  examples: string[];
  distribution?: Record<string, number>;
}

export interface PromptTemplate {
  featureTypes: string[];
  system: string;
  buildUserMessage: (input: PromptInput) => string;
  maxTokens: number;
}

export const DESCRIPTION_PROMPT: PromptTemplate = {
  featureTypes: [
    "documentation.voice",
    "documentation.whyVsWhat",
    "documentation.redundancy",
    "patterns.pureFunctions",
    "patterns.explicitVsImplicit",
    "errorHandling.errorBoundary",
    "structure.fileOrganization",
  ],
  system:
    "You are a code style analyst. Given statistical observations about a developer's coding patterns, write a concise, actionable style rule description. Output ONLY the description text (1-3 sentences). Do not include markdown formatting or headers.",
  buildUserMessage: (input: PromptInput) => {
    const lines = [
      `Feature: ${input.featureType}`,
      `Dominant pattern: ${JSON.stringify(input.convention)}`,
      `Confidence: ${(input.confidence * 100).toFixed(0)}%`,
      `Consistency: ${(input.consistency * 100).toFixed(0)}%`,
    ];

    if (input.distribution) {
      lines.push(
        `Distribution: ${JSON.stringify(input.distribution)}`,
      );
    }

    if (input.examples.length > 0) {
      lines.push("", "Representative code samples:");
      for (const example of input.examples.slice(0, 5)) {
        lines.push("```", example, "```");
      }
    }

    lines.push(
      "",
      "Write a concise style rule description for this pattern.",
    );

    return lines.join("\n");
  },
  maxTokens: 300,
};

export const REVIEW_VOICE_PROMPT: PromptTemplate = {
  featureTypes: [
    "reviewVoice.tone",
    "reviewVoice.themes",
    "reviewVoice.values",
  ],
  system:
    "You are analyzing a developer's code review comments to understand their review voice and priorities. Given topic frequencies and example comments, synthesize a brief description of what this developer cares about in code reviews. Output ONLY the synthesis text (2-4 sentences). Do not include markdown formatting or headers.",
  buildUserMessage: (input: PromptInput) => {
    const lines = [
      `Review topic: ${input.featureType}`,
      `Pattern: ${JSON.stringify(input.convention)}`,
    ];

    if (input.distribution) {
      lines.push(
        `Topic frequencies: ${JSON.stringify(input.distribution)}`,
      );
    }

    if (input.examples.length > 0) {
      lines.push("", "Example review comments:");
      for (const example of input.examples.slice(0, 5)) {
        lines.push(`- "${example}"`);
      }
    }

    lines.push(
      "",
      "Synthesize what this developer values in code reviews.",
    );

    return lines.join("\n");
  },
  maxTokens: 400,
};

export const AI_ENRICHED_FEATURES = [
  ...DESCRIPTION_PROMPT.featureTypes,
  ...REVIEW_VOICE_PROMPT.featureTypes,
];

export function getPromptForFeature(
  featureType: string,
): PromptTemplate | null {
  if (DESCRIPTION_PROMPT.featureTypes.includes(featureType)) {
    return DESCRIPTION_PROMPT;
  }
  if (REVIEW_VOICE_PROMPT.featureTypes.includes(featureType)) {
    return REVIEW_VOICE_PROMPT;
  }
  return null;
}

export function needsAiEnrichment(featureType: string): boolean {
  return AI_ENRICHED_FEATURES.includes(featureType);
}

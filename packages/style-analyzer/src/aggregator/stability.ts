export type Stability = "high" | "medium" | "low";

/**
 * Stability lookup table derived from RoPGen research and the unified
 * feature taxonomy (docs/research/07-unified-feature-taxonomy.md).
 *
 * Key: an observation type exactly as an extractor emits it (e.g., "naming.variable").
 * Value: stability rating.
 *
 * High = persists even when developer tries to write differently (weight 1.0)
 * Medium = consistent under normal conditions (weight 0.85)
 * Low = varies by project/language/intent (weight 0.7)
 *
 * stability.test.ts fails when an emitted type is neither keyed here nor listed
 * in UNRATED_TYPES, and when a key here names a type no extractor emits.
 */
export const STABILITY_MAP: Record<string, Stability> = {
  // Category 1: Naming Conventions
  "naming.variable": "high",
  "naming.function": "high",
  "naming.type": "high",
  "naming.constant": "high",
  "naming.boolean": "medium",
  "naming.parameter": "medium",
  "naming.enum": "high",
  "naming.private-member": "high",

  // Category 2: Code Structure
  "structure.import-group": "high",
  "structure.import-order": "high",
  "structure.export-style": "high",
  "structure.barrel-file": "medium",
  "structure.export-proximity": "medium",

  // Category 3: Control Flow Patterns
  "control-flow.guard-clause": "high",
  "control-flow.ternary": "medium",
  "control-flow.array-method": "high",
  "control-flow.for-loop": "medium",
  "control-flow.for-of": "medium",
  "control-flow.for-in": "medium",
  "control-flow.async-await": "high",

  // Category 4: Error Handling
  "error-handling.try-catch": "high",
  "error-handling.catch-specificity": "medium",
  "error-handling.result-type": "high",
  "error-handling.custom-error-class": "medium",
  "error-handling.exhaustive-switch": "high",
  "error-handling.assert-never": "high",

  // Category 5: Documentation
  "documentation.jsdoc-presence": "high",
  "documentation.public-coverage": "medium",
  "documentation.private-coverage": "medium",
  "documentation.inline-comment": "medium",
  "documentation.comment-placement": "medium",
  "documentation.jsdoc-tag": "medium",

  // Category 7: Formatting & Layout
  "formatting.indentStyle": "high",
  "formatting.indentSize": "high",
  "formatting.semicolons": "high",
  "formatting.quoteStyle": "high",
  "formatting.trailingCommas": "high",
  "formatting.braceStyle": "high",
  "formatting.trailingNewline": "high",

  // Category 9: Habitual Idioms
  "idiom.clone": "high",

  // Category 10: Review Voice
  "reviewVoice.topicFrequency": "medium",
  "reviewVoice.keyword": "medium",

  // Complexity (from task-07)
  "complexity.functionLength": "high",
  "complexity.nestingDepth": "high",
  "complexity.cyclomatic": "high",
  "complexity.fileLength": "medium",
};

/**
 * Emitted types the taxonomy gives no rating. They take the medium default on
 * purpose, and each is an open question for the profile's owner.
 */
export const UNRATED_TYPES: ReadonlySet<string> = new Set([
  "control-flow.if-else",
  "control-flow.promise-then",
  "control-flow.else-after-return",
]);

export function lookupStability(type: string): Stability {
  if (STABILITY_MAP[type]) return STABILITY_MAP[type];

  const category = type.indexOf(".") > 0 ? type.substring(0, type.indexOf(".")) : type;
  if (STABILITY_MAP[category]) return STABILITY_MAP[category];

  return "medium";
}

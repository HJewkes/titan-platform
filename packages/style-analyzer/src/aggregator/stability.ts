export type Stability = "high" | "medium" | "low";

/**
 * Stability lookup table derived from RoPGen research and the unified
 * feature taxonomy (docs/research/07-unified-feature-taxonomy.md).
 *
 * Key: observation type (e.g., "naming.variables").
 * Value: stability rating.
 *
 * High = persists even when developer tries to write differently (weight 1.0)
 * Medium = consistent under normal conditions (weight 0.85)
 * Low = varies by project/language/intent (weight 0.7)
 */
export const STABILITY_MAP: Record<string, Stability> = {
  // Category 1: Naming Conventions
  "naming.variables": "high",
  "naming.functions": "high",
  "naming.types": "high",
  "naming.constants": "high",
  "naming.files": "high",
  "naming.booleans": "medium",
  "naming.abbreviations": "medium",
  "naming.parameters": "medium",
  "naming.enums": "high",
  "naming.privateMembers": "high",

  // Category 2: Code Structure
  "structure.import-group": "high",
  "structure.import-order": "high",
  "structure.importPathStyle": "medium",
  "structure.typeImportSeparation": "medium",
  "structure.export-style": "high",
  "structure.barrel-file": "medium",
  "structure.export-proximity": "medium",
  "structure.functionLength": "high",
  "structure.nestingDepth": "high",
  "structure.fileLength": "medium",
  "structure.moduleTopology": "low",
  "structure.fileOrganization": "low",

  // Category 3: Control Flow Patterns
  "controlFlow.guardClauses": "high",
  "controlFlow.earlyReturn": "high",
  "controlFlow.ternaryPreference": "medium",
  "controlFlow.arrayMethods": "high",
  "controlFlow.forStyle": "medium",
  "controlFlow.asyncAwait": "high",
  "controlFlow.switchVsIf": "medium",
  "controlFlow.optionalChaining": "medium",
  "controlFlow.nullishCoalescing": "low",

  // Category 4: Error Handling
  "errorHandling.tryCatchFrequency": "high",
  "errorHandling.catchSpecificity": "medium",
  "errorHandling.resultType": "high",
  "errorHandling.errorReturnTuples": "medium",
  "errorHandling.customErrorClasses": "medium",
  "errorHandling.exhaustiveSwitch": "high",
  "errorHandling.assertNever": "high",
  "errorHandling.floatingPromises": "medium",
  "errorHandling.errorBoundary": "low",

  // Category 5: Documentation
  "documentation.jsdocPresence": "high",
  "documentation.publicPrivateCoverage": "medium",
  "documentation.inlineCommentDensity": "medium",
  "documentation.commentPlacement": "medium",
  "documentation.sectionComments": "low",
  "documentation.moduleHeaders": "medium",
  "documentation.jsdocTags": "medium",
  "documentation.voice": "low",
  "documentation.whyVsWhat": "low",
  "documentation.redundancy": "low",

  // Category 6: Type System Usage
  "typeSystem.annotationDensity": "high",
  "typeSystem.explicitReturn": "high",
  "typeSystem.moduleBoundaryTypes": "medium",
  "typeSystem.inferrableTypes": "medium",
  "typeSystem.interfaceVsType": "medium",
  "typeSystem.genericUsage": "low",
  "typeSystem.readonlyUsage": "medium",
  "typeSystem.discriminatedUnions": "medium",
  "typeSystem.utilityTypes": "low",

  // Category 7: Formatting & Layout
  "formatting.indentStyle": "high",
  "formatting.indentSize": "high",
  "formatting.semicolons": "high",
  "formatting.quoteStyle": "high",
  "formatting.trailingCommas": "high",
  "formatting.braceStyle": "high",
  "formatting.lineLength": "medium",
  "formatting.blankLines": "medium",
  "formatting.destructuring": "medium",
  "formatting.defaultParams": "low",
  "formatting.arrowVsFunction": "medium",
  "formatting.trailingNewline": "high",

  // Category 8: Higher-Level Patterns
  "patterns.compositionVsInheritance": "medium",
  "patterns.classVsFunctional": "high",
  "patterns.pureFunctions": "low",
  "patterns.immutability": "medium",
  "patterns.explicitVsImplicit": "medium",
  "patterns.dryAdherence": "medium",

  // Category 9: Habitual Idioms
  "idiom.clone": "high",
  "idiom.errorHandlingShape": "medium",
  "idiom.dataTransformation": "medium",
  "idiom.apiCallPattern": "medium",
  "idiom.testStructure": "medium",

  // Category 10: Review Voice
  "reviewVoice.topicFrequency": "medium",
  "reviewVoice.keyword": "medium",
  "reviewVoice.tone": "low",
  "reviewVoice.themes": "low",
  "reviewVoice.values": "low",

  // Complexity (from task-07)
  "complexity.functionLength": "high",
  "complexity.nestingDepth": "high",
  "complexity.cyclomatic": "high",
  "complexity.fileLength": "medium",
};

export function lookupStability(type: string): Stability {
  if (STABILITY_MAP[type]) return STABILITY_MAP[type];

  const category = type.indexOf(".") > 0 ? type.substring(0, type.indexOf(".")) : type;
  if (STABILITY_MAP[category]) return STABILITY_MAP[category];

  return "medium";
}

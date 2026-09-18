import type { StyleExtractor } from "./types.js";
import { NamingExtractor } from "./naming.js";
import { StructureExtractor } from "./structure.js";
import { ControlFlowExtractor } from "./control-flow.js";
import { DocumentationExtractor } from "./documentation.js";
import { ErrorHandlingExtractor } from "./error-handling.js";
import { FormattingExtractor } from "./formatting.js";
import { ComplexityExtractor } from "./complexity.js";
import { IdiomsExtractor } from "./idioms.js";
import { ReviewVoiceExtractor } from "./review-voice.js";

/**
 * Canonical set of style extractors. Single source of truth — CLI commands,
 * scripts, and tests should import this rather than reconstructing the list.
 */
export function createStyleExtractors(): StyleExtractor[] {
  return [
    new NamingExtractor(),
    new StructureExtractor(),
    new ControlFlowExtractor(),
    new DocumentationExtractor(),
    new ErrorHandlingExtractor(),
    new FormattingExtractor(),
    new ComplexityExtractor(),
    new IdiomsExtractor(),
    new ReviewVoiceExtractor(),
  ];
}

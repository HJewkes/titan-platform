export {
  shouldIncludeFile,
  getLanguageFromPath,
  parseFile,
  getSupportedLanguages,
} from "@titan-design/code-parser";

export type {
  StyleExtractor,
  Extractor,
  Observation,
  ObservationCategory,
  ParsedFile,
} from "./extractors/types.js";
export { NamingExtractor } from "./extractors/naming.js";
export { StructureExtractor } from "./extractors/structure.js";
export { ControlFlowExtractor } from "./extractors/control-flow.js";
export { DocumentationExtractor } from "./extractors/documentation.js";
export { ErrorHandlingExtractor } from "./extractors/error-handling.js";
export { FormattingExtractor } from "./extractors/formatting.js";
export { ComplexityExtractor } from "./extractors/complexity.js";
export { IdiomsExtractor } from "./extractors/idioms.js";
export { ReviewVoiceExtractor } from "./extractors/review-voice.js";

export { createStyleExtractors } from "./extractors/factory.js";

import type { Extractor, ParsedFile } from "../parser/index.js";
import { TsMorphGraphExtractor } from "./ts-morph-extractor.js";
import { PythonGraphExtractor } from "./python-extractor.js";
import type { GraphFragment } from "../types.js";

export interface LanguageExtractorOptions {
  repoRoot: string;
  tsConfigPath?: string;
}

/**
 * One extractor over every supported language: each delegate already returns an
 * empty fragment list for files it does not own, so dispatch is a fold. Keeps
 * `assembleFragments` language-agnostic.
 */
export class LanguageExtractor implements Extractor<GraphFragment> {
  readonly name = "language-graph";
  private readonly delegates: Extractor<GraphFragment>[];

  constructor(options: LanguageExtractorOptions) {
    this.delegates = [
      new TsMorphGraphExtractor({ repoRoot: options.repoRoot, tsConfigPath: options.tsConfigPath }),
      new PythonGraphExtractor(options.repoRoot),
    ];
  }

  extract(file: ParsedFile): GraphFragment[] {
    return this.delegates.flatMap((delegate) => delegate.extract(file));
  }
}

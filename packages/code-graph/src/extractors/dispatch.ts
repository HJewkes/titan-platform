import type { Extractor, ParsedFile } from "@titan-design/code-parser";
import { TsMorphGraphExtractor } from "./ts-morph-extractor.js";
import { PythonGraphExtractor } from "./python-extractor.js";
import type { GraphFragment } from "../types.js";
import type { IndexSource } from "../index-source.js";

export interface LanguageExtractorOptions {
  repoRoot: string;
  tsConfigPath?: string;
  source?: IndexSource;
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
    const { repoRoot, tsConfigPath, source } = options;
    this.delegates = [
      new TsMorphGraphExtractor({ repoRoot, tsConfigPath, source }),
      new PythonGraphExtractor(repoRoot, source),
    ];
  }

  extract(file: ParsedFile): GraphFragment[] {
    return this.delegates.flatMap((delegate) => delegate.extract(file));
  }
}

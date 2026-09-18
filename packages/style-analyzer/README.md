# @titan-design/style-analyzer

Tree-sitter style extractors, and the aggregator that turns their output into a style
profile. Each extractor reads a parsed TypeScript or Python file and emits `Observation`
records: one per naming choice, import, branch, comment, function metric, and so on. The
aggregator groups observations by type into features with a dominant convention, a
confidence, a stability and a severity. An optional enricher asks an injected LLM to
describe the features that numbers alone cannot capture.

Tier 2 of the titan-platform DAG (TP-134). Depends on `@titan-design/code-parser` (tier 0)
and `@titan-design/style-profile` (tier 2). `zod` v4 is a peer because style-profile
needs it at runtime. Ported from codewatch's `@codewatch/analyzer`, with two bug fixes
since: stability keys and Python constants (see Gotchas).

```sh
npm install @titan-design/style-analyzer web-tree-sitter@^0.26.6 zod
```

```ts
import { Aggregator, createStyleExtractors, parseFile } from "@titan-design/style-analyzer";

const file = await parseFile(source, "src/users.ts", "typescript");
const observations = createStyleExtractors().flatMap((extractor) => extractor.extract(file));
// { type: "naming.function", category: "naming", value: "camelCase", file: "src/users.ts", line: 3 }

const { features, reviewQueue, summary } = new Aggregator().aggregate(observations);
features.get("formatting.quoteStyle"); // { convention: "double", confidence: 1, severity: "error", ... }
```

## API

- `Observation` is `{ type, category, value, file, line, metadata? }`. `type` is the feature
  (`naming.variable`, `complexity.cyclomatic`), `value` is a string, number or boolean, and
  `line` is 1-based.
- `StyleExtractor` is `Extractor<Observation>` from code-parser. `Extractor` is its
  deprecated alias, kept for compatibility.
- `createStyleExtractors()` returns the canonical nine, in a fixed order: `NamingExtractor`,
  `StructureExtractor`, `ControlFlowExtractor`, `DocumentationExtractor`,
  `ErrorHandlingExtractor`, `FormattingExtractor`, `ComplexityExtractor`, `IdiomsExtractor`,
  `ReviewVoiceExtractor`.
- `FormattingExtractor.extractFromConfig(path)` reads a `.prettierrc` or `.editorconfig`
  from disk. `extractFromSource(text, path)` works on raw text.
- `IdiomsExtractor.extractFromSources([{ path, content, language }])` finds repeated code
  across files with jscpd.
- `ReviewVoiceExtractor.extractFromComments([{ body }])` classifies review comments by
  topic and keyword.
- `new Aggregator(config?).aggregate(observations)` returns `{ features, reviewQueue,
  summary }`. `features` maps each observation type to an `AggregatedFeature`.
  - Confidence is `min(1, consistency * weight)`. Consistency is the dominant value's
    share, and the weight comes from the type's stability (high 1.0, medium 0.85, low 0.7).
  - Severity follows style-profile's thresholds.
  - A feature below `reviewThreshold` (default 0.6) joins `reviewQueue`, lowest first.
  - `computeConfidence`, `mapSeverity` and `lookupStability` are exported on their own.
- `new Enricher({ provider, enabled?, totalTokenBudget? }).enrich(features)` sends one
  prompt per AI-enriched feature (`AI_ENRICHED_FEATURES`, `needsAiEnrichment`).
  - Prompts run sequentially and stop once the token budget is used up (default 20,000).
  - A failed call becomes an entry in `errors` instead of a throw.
  - `enabled: false` returns `skipped: true` without calling the provider.
- `IngestConfig`, `CodeCorpus`, `CodeFile`, `ReviewComment`, `PullRequest`,
  `PullRequestFile` and `IngestMetadata` are the corpus types codewatch's ingestion
  produced. They are types only; the GitHub ingestion itself was not ported.
- `parseFile`, `getSupportedLanguages`, `shouldIncludeFile` and `getLanguageFromPath` are
  re-exported from code-parser, as the original re-exported them from `@codewatch/core`.

## Plugging in an LLM

The enricher never picks a model. It takes an `LlmProvider`:

```ts
interface LlmProvider {
  name: string;
  generate(messages: LlmMessage[], options: { maxTokens: number }): Promise<LlmResponse>;
}
// LlmMessage is { role: "system" | "user" | "assistant", content }
// LlmResponse is { content, tokensUsed }
```

A product that uses `@titan-design/agent` adapts it in a few lines. This package does not
depend on the agent package:

```ts
import { runAgent } from "@titan-design/agent";
import type { LlmProvider } from "@titan-design/style-analyzer";

const agentProvider: LlmProvider = {
  name: "claude-agent",
  async generate(messages) {
    const prompt = messages.map((m) => m.content).join("\n\n");
    const result = await runAgent({ prompt, cwd: process.cwd(), maxTurns: 1, maxBudgetUsd: 0.05 });
    if (!result.ok) throw new Error(result.failure.kind);
    const tokensUsed = Object.values(result.usage.modelUsage)
      .reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0);
    return { content: result.output, tokensUsed };
  },
};
```

`runAgent` has no system prompt field and budgets in turns and dollars, not tokens. The
adapter therefore folds the system message into the prompt and ignores `maxTokens`.
Throwing on a failed run is what lets the enricher record the failure and carry on.

## Dependencies

`web-tree-sitter` is a peer dependency, for the same reason code-parser makes it one:
`ParsedFile.tree` is a web-tree-sitter `Tree`, and the extractors walk it with that
package's `Node` type, so the parser and the extractors must see one copy. This package
imports it for types only. `@jscpd/core` 3.5.10 and `@jscpd/tokenizer` 3.5.4 stay pinned
at the original's versions.

## Gotchas

- `IdiomsExtractor.extract` and `ReviewVoiceExtractor.extract` return `[]`. Their real
  inputs are a set of sources and a list of review comments, not one parsed file.
- `FormattingExtractor` works on text with regular expressions, so it also reports
  semicolons and quote style for Python files.
- `extractFromConfig` swallows every error, including a missing file or malformed JSON,
  and returns `[]`.
- Review-voice observations use `file: "_reviews"` and `line: 0`.
- `STABILITY_MAP` keys are the exact emitted types, and `stability.test.ts` fails in both
  directions when they drift. `UNRATED_TYPES` lists the three emitted types the taxonomy
  never rated (`control-flow.if-else`, `.promise-then`, `.else-after-return`); they take
  `medium` on purpose. The original codewatch map used taxonomy spellings that matched
  none of 30 emitted types, so those types all fell back to `medium` (TP-172).
- A Python assignment counts as `naming.constant` only at module top level, including
  annotated and chained forms (TP-173). Class-level and function-local caps names, and
  single-word caps names such as `DEBUG`, report as `naming.variable`.

The worked example and the full observation list are in the site reference page,
`site/reference/style-analyzer.md`.

import { Extractor as Extractor$1, ParsedFile } from '@titan-design/code-parser';
export { ParsedFile, getLanguageFromPath, getSupportedLanguages, parseFile, shouldIncludeFile } from '@titan-design/code-parser';
import { ProfileCategory, Severity, SeverityThresholds } from '@titan-design/style-profile';
export { Severity, SeverityThresholds, severityForConfidence as mapSeverity } from '@titan-design/style-profile';

interface IngestConfig {
    repos: string[];
    since?: string;
    until?: string;
    languages: string[];
    githubToken: string;
    cacheDir?: string;
}
interface CodeFile {
    path: string;
    content: string;
    language: string;
    repo: string;
    sha: string;
}
interface ReviewComment$1 {
    body: string;
    path: string;
    line: number | null;
    author: string;
    prNumber: number;
    repo: string;
    createdAt: string;
}
interface PullRequest {
    number: number;
    title: string;
    repo: string;
    author: string;
    files: PullRequestFile[];
    comments: ReviewComment$1[];
}
interface PullRequestFile {
    filename: string;
    status: "added" | "modified" | "removed" | "renamed";
    patch?: string;
    additions: number;
    deletions: number;
}
interface CodeCorpus {
    files: CodeFile[];
    pullRequests: PullRequest[];
    reviewComments: ReviewComment$1[];
    metadata: IngestMetadata;
}
interface IngestMetadata {
    repos: string[];
    author: string;
    since?: string;
    until?: string;
    fetchedAt: string;
    totalCommits: number;
    totalFiles: number;
    totalReviewComments: number;
}

/**
 * Categories that extractors emit. Includes all ProfileCategory values
 * plus extractor-specific categories that don't map directly to profile sections.
 */
type ObservationCategory = ProfileCategory | "control-flow" | "error-handling" | "reviewVoice" | "idioms" | "complexity";
interface Observation {
    /** Feature type, e.g. "naming.variable", "naming.function" */
    type: string;
    /** Top-level category, e.g. "naming", "structure" */
    category: ObservationCategory;
    /** Detected value, e.g. "camelCase", true, 28 */
    value: string | number | boolean;
    /** Source file path */
    file: string;
    /** Line number (1-based) */
    line: number;
    /** Additional context for aggregation */
    metadata?: Record<string, unknown>;
}
/** Style extractor — produces per-file style Observations. */
type StyleExtractor = Extractor$1<Observation>;
/** @deprecated Use StyleExtractor. Retained for backward compatibility. */
type Extractor = StyleExtractor;

declare class NamingExtractor implements StyleExtractor {
    readonly name = "naming";
    extract(file: ParsedFile): Observation[];
    private processNode;
    private processTypeScriptNode;
    private processTypeScriptVariable;
    private processTypeScriptParameter;
    private processPythonNode;
    private processPythonAssignment;
    private processPythonParameters;
    private observeVariable;
    private observeDeclarationName;
    private detectPrivateMembers;
    private addObservation;
}

declare class StructureExtractor implements StyleExtractor {
    readonly name = "structure";
    extract(file: ParsedFile): Observation[];
    private extractImports;
    private addImportOrder;
    private importSource;
    private extractExports;
    private processExport;
    private exportProximity;
    private detectBarrelFile;
}

declare class ControlFlowExtractor implements StyleExtractor {
    readonly name = "control-flow";
    extract(file: ParsedFile): Observation[];
    private walk;
    private processNode;
    private processBranch;
    private processLoop;
    private processCall;
    private processMemberCall;
    private detectGuardClause;
    private isFunctionBody;
    private detectElseAfterReturn;
    private containsReturn;
    private emit;
}

declare class DocumentationExtractor implements StyleExtractor {
    readonly name = "documentation";
    extract(file: ParsedFile): Observation[];
    private walkDeclarations;
    private isDeclaration;
    private processDeclaration;
    private hasLeadingDoc;
    private hasJSDoc;
    private hasPythonDocstring;
    private extractTags;
    private extractPythonDocTags;
    private walkForComments;
    private getCommentPlacement;
    private isExported;
    private getLeadingComment;
    private emit;
}

declare class ErrorHandlingExtractor implements StyleExtractor {
    readonly name = "error-handling";
    extract(file: ParsedFile): Observation[];
    private walk;
    private processNode;
    private processDeclaration;
    private processFunctionCheck;
    private analyzeCatchClauses;
    private hasInstanceofCheck;
    private detectCustomErrorClass;
    private pythonBaseNodes;
    private extendsNodes;
    private detectResultType;
    private detectResultReturnType;
    private detectAssertNever;
    private detectExhaustiveSwitch;
    private emit;
}

declare class FormattingExtractor implements StyleExtractor {
    readonly name = "formatting";
    extract(file: ParsedFile): Observation[];
    extractFromConfig(configPath: string): Promise<Observation[]>;
    extractFromSource(source: string, filePath: string): Observation[];
    private detectSemicolons;
    private detectQuoteStyle;
    private detectTrailingCommas;
    private detectBraceStyle;
    private detectIndentation;
    private countIndentation;
    private isComment;
    private isStructuralLine;
    private isStatementStart;
    private findGcdOfArray;
    private gcd;
}

declare class ComplexityExtractor implements StyleExtractor {
    readonly name = "complexity";
    extract(file: ParsedFile): Observation[];
    private functionObservations;
    private getFunctionTypes;
    private findFunctions;
    private analyzeFunctionNode;
    private countStatements;
    private isStatement;
    private isTypeScriptStatement;
    private isPythonStatement;
    private measureNestingDepth;
    private measureCyclomaticComplexity;
    private branchIncrement;
}

interface SourceFile {
    content: string;
    path: string;
    language: string;
}
declare class IdiomsExtractor implements StyleExtractor {
    readonly name = "idioms";
    private minLines;
    private minTokens;
    constructor(options?: {
        minLines?: number;
        minTokens?: number;
    });
    extract(_file: ParsedFile): Observation[];
    extractFromSources(sources: SourceFile[]): Promise<Observation[]>;
    private cloneObservation;
    private detectClones;
    private runDetector;
    private toCloneGroup;
    private toInstance;
    private extractFragment;
    private languageToFormat;
    private groupClones;
    private mergeInstances;
    private normalizeFragment;
    private summarizeClone;
}

interface ReviewComment {
    body: string;
    file?: string;
}
declare class ReviewVoiceExtractor implements StyleExtractor {
    readonly name = "reviewVoice";
    extract(_file: ParsedFile): Observation[];
    extractFromComments(comments: ReviewComment[]): Observation[];
    private categorizeTopics;
    private countTopics;
    private matchTopics;
    private extractKeywords;
}

/**
 * Canonical set of style extractors. Single source of truth — CLI commands,
 * scripts, and tests should import this rather than reconstructing the list.
 */
declare function createStyleExtractors(): StyleExtractor[];

type Stability = "high" | "medium" | "low";
declare function lookupStability(type: string): Stability;

interface StabilityWeights {
    high: number;
    medium: number;
    low: number;
}
declare function computeConfidence(consistency: number, stability: Stability, weights?: StabilityWeights): number;

interface FrequencyDistribution {
    values: Map<string | number | boolean, number>;
    total: number;
    dominant: string | number | boolean;
    consistency: number;
}

interface AggregatedFeature {
    type: string;
    category: ObservationCategory;
    convention: string | number | boolean | string[];
    distribution: FrequencyDistribution;
    confidence: number;
    stability: Stability;
    severity: Severity;
    needsReview: boolean;
    examples: Observation[];
}
interface AggregatorConfig {
    stabilityWeights?: StabilityWeights;
    severityThresholds?: SeverityThresholds;
    reviewThreshold?: number;
    maxExamples?: number;
}
interface AggregatorResult {
    features: Map<string, AggregatedFeature>;
    reviewQueue: AggregatedFeature[];
    summary: {
        totalObservations: number;
        totalFeatures: number;
        avgConfidence: number;
        featuresNeedingReview: number;
    };
}
declare class Aggregator {
    private stabilityWeights;
    private severityThresholds;
    private reviewThreshold;
    private maxExamples;
    constructor(config?: AggregatorConfig);
    aggregate(observations: Observation[]): AggregatorResult;
    private buildFeature;
    private extractCategory;
}

interface LlmMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
interface LlmResponse {
    content: string;
    tokensUsed: number;
}
interface LlmProvider {
    name: string;
    generate(messages: LlmMessage[], options: {
        maxTokens: number;
    }): Promise<LlmResponse>;
}

declare const AI_ENRICHED_FEATURES: string[];
declare function needsAiEnrichment(featureType: string): boolean;

interface EnrichmentEntry {
    featureType: string;
    description: string;
    tokensUsed: number;
}
interface EnrichmentError {
    featureType: string;
    error: string;
}
interface EnrichmentResult {
    enriched: Map<string, EnrichmentEntry>;
    errors: EnrichmentError[];
    totalTokensUsed: number;
    budgetExceeded: boolean;
    skipped: boolean;
}
interface EnricherConfig {
    provider: LlmProvider;
    enabled?: boolean;
    totalTokenBudget?: number;
}
declare class Enricher {
    private runner;
    private enabled;
    constructor(config: EnricherConfig);
    enrich(features: Map<string, AggregatedFeature>): Promise<EnrichmentResult>;
    private buildJobs;
    private buildPromptInput;
}

export { AI_ENRICHED_FEATURES, type AggregatedFeature, Aggregator, type AggregatorConfig, type AggregatorResult, type CodeCorpus, type CodeFile, ComplexityExtractor, ControlFlowExtractor, DocumentationExtractor, Enricher, type EnricherConfig, type EnrichmentEntry, type EnrichmentError, type EnrichmentResult, ErrorHandlingExtractor, type Extractor, FormattingExtractor, type FrequencyDistribution, IdiomsExtractor, type IngestConfig, type IngestMetadata, type LlmMessage, type LlmProvider, type LlmResponse, NamingExtractor, type Observation, type ObservationCategory, type PullRequest, type PullRequestFile, type ReviewComment$1 as ReviewComment, ReviewVoiceExtractor, type Stability, type StabilityWeights, StructureExtractor, type StyleExtractor, computeConfidence, createStyleExtractors, lookupStability, needsAiEnrichment };

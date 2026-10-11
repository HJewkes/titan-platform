import { z } from 'zod';
import { Migration, Db, WatermarkTable } from '@titan-design/store-sqlite';
import { Embedder } from '@titan-design/embed';
import { VectorIndex, Degradation } from '@titan-design/retrieval';

/**
 * The playbook data model, borrowed from cass-memory's `PlaybookBullet`. Counts
 * are never stored: they are derived from the append-only feedback log at read
 * time, so decay parameters can change without re-running reflection.
 */
declare const BULLET_SCOPES: readonly ["global", "workspace", "language", "framework", "task"];
declare const BULLET_TYPES: readonly ["rule", "anti-pattern"];
declare const BULLET_KINDS: readonly ["project_convention", "stack_pattern", "workflow_rule", "anti_pattern"];
declare const BULLET_SOURCES: readonly ["learned", "community", "manual", "custom"];
declare const BULLET_STATES: readonly ["draft", "active", "retired"];
declare const MATURITIES: readonly ["candidate", "established", "proven", "deprecated"];
type BulletScope = (typeof BULLET_SCOPES)[number];
type BulletType = (typeof BULLET_TYPES)[number];
type BulletKind = (typeof BULLET_KINDS)[number];
type BulletSource = (typeof BULLET_SOURCES)[number];
type BulletState = (typeof BULLET_STATES)[number];
type Maturity = (typeof MATURITIES)[number];
type FeedbackType = "helpful" | "harmful";
/** Where a bullet's evidence lives: a session ref plus a byte offset into its transcript. */
interface Provenance {
    sessionRef: string;
    byteOffset?: number;
}
interface Bullet {
    id: string;
    content: string;
    category: string;
    tags: string[];
    scope: BulletScope;
    type: BulletType;
    kind: BulletKind;
    isNegative: boolean;
    source: BulletSource;
    state: BulletState;
    maturity: Maturity;
    pinned: boolean;
    pinnedReason: string | null;
    /** Set when retired in favour of another bullet; mirrored by a `supersedes` edge. */
    replacedBy: string | null;
    deprecatedAt: string | null;
    deprecationReason: string | null;
    halfLifeDays: number;
    sourceSessions: Provenance[];
    reasoning: string | null;
    createdAt: string;
    updatedAt: string;
}
interface NewBullet {
    id?: string;
    content: string;
    category?: string;
    tags?: string[];
    scope?: BulletScope;
    type?: BulletType;
    kind?: BulletKind;
    isNegative?: boolean;
    source?: BulletSource;
    state?: BulletState;
    pinned?: boolean;
    pinnedReason?: string | null;
    halfLifeDays?: number;
    sourceSessions?: Provenance[];
    reasoning?: string | null;
}
/** One line of the immutable feedback log. */
interface FeedbackEvent {
    id: number;
    bulletId: string;
    type: FeedbackType;
    at: string;
    sessionRef: string | null;
    reason: string | null;
}
interface DecayedCounts {
    helpful: number;
    harmful: number;
}
interface ScoredBullet extends Bullet {
    helpfulCount: number;
    harmfulCount: number;
    decayedHelpful: number;
    decayedHarmful: number;
    effectiveScore: number;
    /** Latest feedback, or creation when there is none; the input to staleness. */
    lastEvidenceAt: string;
}
/**
 * What a reflector proposes. Provenance is deliberately absent: the curator
 * stamps it from the session it is actually processing, never from the model.
 */
declare const addDelta: z.ZodObject<{
    type: z.ZodLiteral<"add">;
    content: z.ZodString;
    category: z.ZodDefault<z.ZodString>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    scope: z.ZodDefault<z.ZodEnum<{
        global: "global";
        workspace: "workspace";
        language: "language";
        framework: "framework";
        task: "task";
    }>>;
    kind: z.ZodDefault<z.ZodEnum<{
        project_convention: "project_convention";
        stack_pattern: "stack_pattern";
        workflow_rule: "workflow_rule";
        anti_pattern: "anti_pattern";
    }>>;
    isNegative: z.ZodDefault<z.ZodBoolean>;
    reasoning: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const PlaybookDeltaSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"add">;
    content: z.ZodString;
    category: z.ZodDefault<z.ZodString>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    scope: z.ZodDefault<z.ZodEnum<{
        global: "global";
        workspace: "workspace";
        language: "language";
        framework: "framework";
        task: "task";
    }>>;
    kind: z.ZodDefault<z.ZodEnum<{
        project_convention: "project_convention";
        stack_pattern: "stack_pattern";
        workflow_rule: "workflow_rule";
        anti_pattern: "anti_pattern";
    }>>;
    isNegative: z.ZodDefault<z.ZodBoolean>;
    reasoning: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<FeedbackType>;
    bulletId: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<FeedbackType>;
    bulletId: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"replace">;
    bulletId: z.ZodString;
    content: z.ZodString;
    reasoning: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"deprecate">;
    bulletId: z.ZodString;
    reason: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"merge">;
    bulletIds: z.ZodArray<z.ZodString>;
    content: z.ZodString;
    reasoning: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "type">;
/** What callers and reflectors write; defaults may be omitted. */
type PlaybookDelta = z.input<typeof PlaybookDeltaSchema>;
/** What the curator works on, after parsing fills the defaults in. */
type ParsedDelta = z.output<typeof PlaybookDeltaSchema>;
type AddDelta = z.output<typeof addDelta>;

/**
 * Four kit tables plus one domain table. Bullets are interval entities, the
 * `supersedes` relation lives in the edge table, embeddings in cache_blob keyed
 * by content hash, and per-session progress in the watermark table.
 */
interface MemoryTables {
    entity: string;
    edge: string;
    cacheBlob: string;
    watermark: string;
    feedback: string;
}
declare const DEFAULT_MEMORY_TABLES: MemoryTables;
declare const SUPERSEDES = "supersedes";
declare function feedbackTableDdl(name?: string): string;
declare function memoryDdl(tables?: MemoryTables): string;
/** Drop into a product's migration list so the playbook shares its database. */
declare function memoryMigration(version: number, tables?: MemoryTables): Migration;

/** cass-memory's exact numbers; a bullet may override the half-life, nothing else. */
declare const DEFAULT_HALF_LIFE_DAYS = 90;
declare const HARMFUL_WEIGHT = 4;
declare const HARD_DEPRECATE_SCORE = -3;
declare const MATURITY_MULTIPLIER: Record<Maturity, number>;
declare function decayedValue(at: string, now: Date, halfLifeDays?: number): number;
declare function decayedCounts(events: readonly FeedbackEvent[], now: Date, halfLifeDays?: number): DecayedCounts;
declare function effectiveScore(counts: DecayedCounts, maturity: Maturity): number;
/** The maturity the decayed counts alone would assign, ignoring history. */
declare function maturityFor(counts: DecayedCounts): Maturity;
/**
 * Promotion jumps straight to the earned rung; demotion drops one rung per
 * pass, except that a score below the hard floor deprecates outright. Pinned
 * bullets never move.
 */
declare function nextMaturity(current: Maturity, counts: DecayedCounts, pinned: boolean): Maturity;
interface StalenessOptions {
    /** Days without any feedback before a bullet is flagged for re-validation. */
    staleAfterDays?: number;
}
/** Staleness is about silence, not decay: a bullet nobody has confirmed or refuted lately. */
declare function isStale(lastEvidenceAt: string, now: Date, { staleAfterDays }?: StalenessOptions): boolean;

/** Lowercase alphanumeric tokens of two or more characters, as a set. */
declare function tokenize(text: string): Set<string>;
/** Case- and whitespace-insensitive form used for exact-duplicate detection. */
declare function normalizeContent(text: string): string;
declare function contentKey(text: string): string;
declare function jaccard(a: string, b: string): number;

declare const bulletRef: (id: string) => string;
interface PlaybookStoreOptions {
    tables?: MemoryTables;
    now?: () => Date;
}
interface FeedbackInput {
    sessionRef?: string | null;
    reason?: string | null;
    at?: string;
}
interface BlockedPattern {
    pattern: string;
    reason: string;
    blockedAt: string;
}
declare class BulletNotFound extends Error {
    constructor(id: string);
}
/**
 * Bullets are interval entities (`kind = bullet`, name = category, attrs = the
 * rest), so retirement is an attrs change plus a `supersedes` edge, never a
 * delete. Feedback is an append-only log; nothing here ever updates or removes
 * an event.
 */
declare class PlaybookStore {
    readonly tables: MemoryTables;
    private readonly entities;
    private readonly edges;
    private readonly now;
    private readonly insertFeedback;
    private readonly feedbackByBullet;
    private readonly allFeedback;
    constructor(db: Db, options?: PlaybookStoreOptions);
    add(input: NewBullet): Bullet;
    get(id: string): Bullet | undefined;
    require(id: string): Bullet;
    /** Live bullets only, unless `includeRetired`; ordered by id for determinism. */
    list({ includeRetired }?: {
        includeRetired?: boolean;
    }): Bullet[];
    update(id: string, patch: Partial<Omit<Bullet, "id" | "createdAt">>): Bullet;
    /** Retire a bullet. With `replacedBy`, also assert `replacedBy -supersedes-> id`. */
    deprecate(id: string, reason: string, replacedBy?: string | null): Bullet;
    /** Ids of the bullets this one replaced, following live `supersedes` edges. */
    supersededBy(id: string): string[];
    recordFeedback(id: string, type: FeedbackType, input?: FeedbackInput): FeedbackEvent;
    feedbackFor(id: string): FeedbackEvent[];
    /** Every event grouped by bullet id, one query, for scoring the whole playbook. */
    feedbackByBulletId(): Map<string, FeedbackEvent[]>;
    /** A content pattern a human has banned; the curator refuses to re-learn anything near it. */
    block(pattern: string, reason: string): BlockedPattern;
    blockedPatterns(): BlockedPattern[];
    private write;
}
declare function newBulletId(now?: Date): string;

declare function scoreBullet(bullet: Bullet, events: readonly FeedbackEvent[], now: Date): ScoredBullet;
interface ScoreOptions {
    includeRetired?: boolean;
}
/** Every bullet with its decayed counts and score as of `now`. One feedback query for the whole playbook. */
declare function scorePlaybook(store: PlaybookStore, now: Date, options?: ScoreOptions): ScoredBullet[];
interface MaturityChange {
    bulletId: string;
    from: Maturity;
    to: Maturity;
}
/** The promotion/demotion pass. A bullet that lands on `deprecated` is retired. */
declare function applyMaturity(store: PlaybookStore, now: Date): MaturityChange[];
/** Live bullets nobody has confirmed or refuted lately: candidates for re-validation, not for removal. */
declare function staleBullets(store: PlaybookStore, now: Date, options?: StalenessOptions): ScoredBullet[];

interface InversionOptions {
    /** Decayed harmful mass a rule needs before it can flip into an anti-pattern. */
    minHarmful?: number;
    /** And by how much harmful must outweigh helpful. */
    harmfulToHelpfulRatio?: number;
}
interface CurateOptions {
    /** Stamped onto every bullet this batch creates. Never taken from the deltas themselves. */
    provenance?: Provenance;
    now?: () => Date;
    /** Jaccard similarity at which an `add` folds into a `helpful` on the existing bullet. */
    nearDupThreshold?: number;
    /** Jaccard similarity at which two rules are flagged as possibly contradicting. */
    conflictThreshold?: number;
    inversion?: InversionOptions;
}
interface Conflict {
    bulletId: string;
    otherId: string;
    reason: string;
}
interface CurationReport {
    added: string[];
    reinforced: string[];
    penalized: string[];
    deprecated: string[];
    inverted: {
        from: string;
        to: string;
    }[];
    blocked: string[];
    skipped: {
        delta: ParsedDelta;
        reason: string;
    }[];
    conflicts: Conflict[];
    maturityChanges: MaturityChange[];
}
/**
 * cass-memory's curator: zero LLM, fully deterministic. Dedup by content hash
 * and near-dup Jaccard, apply the batch, invert rules that keep hurting into
 * `AVOID:` anti-patterns, then run the maturity pass.
 */
declare function curate(store: PlaybookStore, deltas: readonly PlaybookDelta[], options?: CurateOptions): CurationReport;

interface SemanticOptions {
    embedder: Embedder;
    index: VectorIndex;
    /** Share of relevance taken from vector similarity; the rest is keyword score. */
    weight?: number;
    timeoutMs?: number;
}
interface RecallOptions {
    limit?: number;
    /** Extra tags to match on top of the query's own tokens. */
    tags?: string[];
    /** Keep bullets scoped `global` or to this scope. */
    scope?: BulletScope;
    now?: Date;
    /** Filter on relevance, not final score, so a low-confidence but topical bullet still surfaces. */
    minRelevance?: number;
    semantic?: SemanticOptions;
}
interface RecalledBullet extends ScoredBullet {
    keywordScore: number;
    semanticScore: number | null;
    relevanceScore: number;
    finalScore: number;
}
interface RecallResult {
    bullets: RecalledBullet[];
    antiPatterns: RecalledBullet[];
    deprecatedWarnings: RecalledBullet[];
    /** Why semantic scoring fell back to keywords, if it did. Never silent. */
    degraded: Degradation[];
}
/**
 * cass-memory's `cm context`: keyword score blended with optional vector
 * similarity, multiplied by the bullet's floored confidence, so what comes back
 * is topical first and trusted second.
 */
declare function recall(store: PlaybookStore, query: string, options?: RecallOptions): Promise<RecallResult>;
declare function keywordScore(content: string, tags: readonly string[], query: string, extraTags?: readonly string[]): number;

interface MemoryVectorsOptions {
    tables?: MemoryTables;
    namespace?: string;
}
/**
 * Bullet embeddings in cache_blob, keyed by normalized content and the
 * embedder's model, so a re-worded bullet re-embeds and everything else is a
 * cache hit. The index is rebuilt from the cache; nothing is stored twice.
 */
declare class MemoryVectors {
    private readonly embedder;
    private readonly cache;
    private readonly namespace;
    constructor(db: Db, embedder: Embedder, options?: MemoryVectorsOptions);
    /** Embed every bullet the cache does not have, in one call. Returns how many were computed. */
    ensure(bullets: readonly Bullet[]): Promise<number>;
    /** A searchable index over these bullets, embedding any misses first. */
    index(bullets: readonly Bullet[]): Promise<VectorIndex>;
    private keyFor;
}

interface ReflectInput {
    sessionRef: string;
    /** Whatever the caller distilled from the session: a diary, a subgraph summary, raw notes. */
    diary: string;
    iteration: number;
    bullets: Bullet[];
    priorDeltas: ParsedDelta[];
}
/** The one stage that may call a model. Returns anything; the deltas are validated here, not trusted. */
type Reflector = (input: ReflectInput) => Promise<unknown>;
interface ReflectSessionInput {
    sessionRef: string;
    diary: string;
    byteOffset?: number;
}
interface ReflectOptions extends Omit<CurateOptions, "provenance"> {
    maxIterations?: number;
    maxDeltas?: number;
}
interface RejectedDelta {
    iteration: number;
    index: number;
    reason: string;
}
interface ReflectionResult {
    deltas: ParsedDelta[];
    rejected: RejectedDelta[];
    iterations: number;
    report: CurationReport;
}
interface ReflectDeps {
    store: PlaybookStore;
    /** When present, the session's offset is recorded so incremental runs know where they stopped. */
    watermark?: WatermarkTable;
}
/**
 * cass-memory's multi-iteration reflect loop: feed the growing playbook and the
 * deltas so far back in, stop early on nothing new or at the cap, then curate
 * with provenance stamped from the input, never from the model.
 */
declare function reflectSession(deps: ReflectDeps, input: ReflectSessionInput, reflector: Reflector, options?: ReflectOptions): Promise<ReflectionResult>;
declare function parseDeltas(raw: unknown, seen: Set<string>, iteration: number, rejected: RejectedDelta[]): ParsedDelta[];

/** Where a Claude Code auto-memory fact file came from; `host` marks a read-only mirror of another machine. */
interface MemorySourceRef {
    account: string;
    project: string;
    path: string;
    host?: string;
}
declare const MEMORY_FACT_TYPES: readonly ["user", "feedback", "project", "reference", "unknown"];
type MemoryFactType = (typeof MEMORY_FACT_TYPES)[number];
interface ParsedFact {
    ok: true;
    ref: MemorySourceRef;
    name: string;
    description: string;
    type: MemoryFactType;
    body: string;
    modified?: string;
    /** `contentKey(description + "\n" + body)`: case- and whitespace-insensitive. */
    contentHash: string;
}
interface ParseFailure {
    ok: false;
    ref: MemorySourceRef;
    error: string;
}
/** One `- [Title](file.md) — hook` line of a `MEMORY.md` index; `line` is 1-based. */
interface MemoryIndexPointer {
    file: string;
    title: string;
    line: number;
}
/** A fact and every file that says the same thing; `fact` is the representative. */
interface DedupedFact {
    fact: ParsedFact;
    sources: ParsedFact[];
}
interface FactGroup {
    label: string;
    facts: DedupedFact[];
}
interface SkillSummary {
    name: string;
    description: string;
}
type MemoryDestination = `skill:${string}` | `new-skill:${string}` | "charter" | `claude-md:${string}` | "delete";
interface DestinationProposal {
    destination: MemoryDestination;
    reason: string;
}

/** Parses one auto-memory fact file. Never throws: a file it cannot read comes back as a `ParseFailure`. */
declare function parseMemoryFile(raw: string, ref: MemorySourceRef): ParsedFact | ParseFailure;
/** Reads the pointer lines of a `MEMORY.md` index; prose lines are skipped. */
declare function parseMemoryIndex(raw: string): MemoryIndexPointer[];

interface DedupeOptions {
    nearDup?: number;
}
/**
 * Merges facts with the same content key, then near-duplicates at or above `nearDup` Jaccard. A rule and its
 * negation share most tokens, so near-duplicates merge only when both have the same polarity.
 */
declare function dedupeFacts(facts: readonly ParsedFact[], options?: DedupeOptions): DedupedFact[];

interface GroupOptions {
    threshold?: number;
}
/** The topic tokens of a fact or skill: its tokenized name and description minus the stop list. */
declare function topicTokens(text: string): Set<string>;
/** Single-link groups over topic-token Jaccard, largest first, then by label; stable for any input order. */
declare function groupFacts(deduped: readonly DedupedFact[], options?: GroupOptions): FactGroup[];

interface ProposeOptions {
    now: Date;
    staleDays?: number;
}
/** Proposes where a group of facts should live; the first matching rule wins, so the order is the policy. */
declare function proposeDestination(group: FactGroup, skills: readonly SkillSummary[], options: ProposeOptions): DestinationProposal;

export { type AddDelta, BULLET_KINDS, BULLET_SCOPES, BULLET_SOURCES, BULLET_STATES, BULLET_TYPES, type BlockedPattern, type Bullet, type BulletKind, BulletNotFound, type BulletScope, type BulletSource, type BulletState, type BulletType, type Conflict, type CurateOptions, type CurationReport, DEFAULT_HALF_LIFE_DAYS, DEFAULT_MEMORY_TABLES, type DecayedCounts, type DedupeOptions, type DedupedFact, type DestinationProposal, type FactGroup, type FeedbackEvent, type FeedbackInput, type FeedbackType, type GroupOptions, HARD_DEPRECATE_SCORE, HARMFUL_WEIGHT, type InversionOptions, MATURITIES, MATURITY_MULTIPLIER, MEMORY_FACT_TYPES, type Maturity, type MaturityChange, type MemoryDestination, type MemoryFactType, type MemoryIndexPointer, type MemorySourceRef, type MemoryTables, MemoryVectors, type MemoryVectorsOptions, type NewBullet, type ParseFailure, type ParsedDelta, type ParsedFact, type PlaybookDelta, PlaybookDeltaSchema, PlaybookStore, type PlaybookStoreOptions, type ProposeOptions, type Provenance, type RecallOptions, type RecallResult, type RecalledBullet, type ReflectDeps, type ReflectInput, type ReflectOptions, type ReflectSessionInput, type ReflectionResult, type Reflector, type RejectedDelta, SUPERSEDES, type ScoreOptions, type ScoredBullet, type SemanticOptions, type SkillSummary, type StalenessOptions, applyMaturity, bulletRef, contentKey, curate, decayedCounts, decayedValue, dedupeFacts, effectiveScore, feedbackTableDdl, groupFacts, isStale, jaccard, keywordScore, maturityFor, memoryDdl, memoryMigration, newBulletId, nextMaturity, normalizeContent, parseDeltas, parseMemoryFile, parseMemoryIndex, proposeDestination, recall, reflectSession, scoreBullet, scorePlaybook, staleBullets, tokenize, topicTokens };

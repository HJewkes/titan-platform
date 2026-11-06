import { z } from 'zod';
import { Migration, Db, WatermarkTable } from '@titan-design/store-sqlite';
import { Maturity, NewBullet, PlaybookStore, ScoredBullet, FeedbackEvent, FeedbackType, MaturityChange } from '@titan-design/memory';

declare const LEDGER_SOURCES: readonly ["transcript", "note", "queue", "decided", "endorse", "morning"];
declare const ANSWERED_BY: readonly ["owner-terminal", "owner-remote", "decider", "overrule"];
declare const ROUTES: readonly ["owner-now", "owner-queue", "decider"];
/** Where the row came from, precise enough to re-read the original bytes. */
declare const LedgerLocatorSchema: z.ZodObject<{
    path: z.ZodString;
    byteOffset: z.ZodOptional<z.ZodNumber>;
    sessionId: z.ZodOptional<z.ZodString>;
    toolUseId: z.ZodOptional<z.ZodString>;
    msgId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const LedgerOptionSchema: z.ZodObject<{
    label: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const PredictionSchema: z.ZodObject<{
    answer: z.ZodString;
    confidence: z.ZodNumber;
    principleIds: z.ZodArray<z.ZodString>;
    escalate: z.ZodBoolean;
}, z.core.$strip>;
/**
 * A ledger row. Parses v2 rows and active-work's v1 `PrecedentRow` alike: a v1 row keeps
 * `v: 1`, its `class` becomes `category` and its `pick_type` yields `outcome`.
 */
declare const LedgerRowSchema: z.ZodPipe<z.ZodObject<{
    key: z.ZodString;
    v: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>]>>;
    source: z.ZodEnum<{
        transcript: "transcript";
        note: "note";
        queue: "queue";
        decided: "decided";
        endorse: "endorse";
        morning: "morning";
    }>;
    asked_at: z.ZodNullable<z.ZodString>;
    answered_at: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    locator: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        path: z.ZodString;
        byteOffset: z.ZodOptional<z.ZodNumber>;
        sessionId: z.ZodOptional<z.ZodString>;
        toolUseId: z.ZodOptional<z.ZodString>;
        msgId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    session_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    tool_use_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    initiative: z.ZodNullable<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
    class: z.ZodOptional<z.ZodString>;
    header: z.ZodNullable<z.ZodString>;
    question: z.ZodString;
    options: z.ZodArray<z.ZodUnion<readonly [z.ZodPipe<z.ZodString, z.ZodTransform<{
        label: string;
    }, string>>, z.ZodObject<{
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>]>>;
    recommended: z.ZodNullable<z.ZodString>;
    answer: z.ZodNullable<z.ZodString>;
    pick_type: z.ZodOptional<z.ZodEnum<{
        recommended: "recommended";
        other_option: "other_option";
        free_text: "free_text";
        rejected: "rejected";
        unparsed: "unparsed";
        none: "none";
    }>>;
    free_text: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    outcome: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        none: "none";
        accept: "accept";
        amend: "amend";
        other: "other";
        redirect: "redirect";
        bulk: "bulk";
    }>>>;
    covers: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    bulk_from: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        outcome: z.ZodEnum<{
            accept: "accept";
            amend: "amend";
        }>;
        covers: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>>;
    answered_by: z.ZodDefault<z.ZodEnum<{
        "owner-terminal": "owner-terminal";
        "owner-remote": "owner-remote";
        decider: "decider";
        overrule: "overrule";
    }>>;
    route: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
        decider: "decider";
        "owner-now": "owner-now";
        "owner-queue": "owner-queue";
    }>>>;
    prediction: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        answer: z.ZodString;
        confidence: z.ZodNumber;
        principleIds: z.ZodArray<z.ZodString>;
        escalate: z.ZodBoolean;
    }, z.core.$strip>>>;
    unclaimed: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>, z.ZodTransform<{
    category: string;
    recommended: string | null;
    outcome: "none" | "accept" | "amend" | "other" | "redirect" | "bulk" | null;
    covers: number | null;
    bulk_from: null;
    key: string;
    v: 2 | 1;
    source: "transcript" | "note" | "queue" | "decided" | "endorse" | "morning";
    asked_at: string | null;
    answered_at: string | null;
    locator: {
        path: string;
        byteOffset?: number | undefined;
        sessionId?: string | undefined;
        toolUseId?: string | undefined;
        msgId?: string | undefined;
    } | null;
    session_id: string | null;
    tool_use_id: string | null;
    initiative: string | null;
    header: string | null;
    question: string;
    options: ({
        label: string;
    } | {
        label: string;
        description?: string | undefined;
    })[];
    answer: string | null;
    free_text: string | null;
    answered_by: "owner-terminal" | "owner-remote" | "decider" | "overrule";
    route: "decider" | "owner-now" | "owner-queue" | null;
    prediction: {
        answer: string;
        confidence: number;
        principleIds: string[];
        escalate: boolean;
    } | null;
    unclaimed: boolean;
    pick_type?: "recommended" | "other_option" | "free_text" | "rejected" | "unparsed" | "none" | undefined;
} | {
    category: string;
    recommended: string | null;
    outcome: "bulk";
    covers: number | null;
    bulk_from: {
        outcome: "accept" | "amend";
        covers: number | null;
    };
    key: string;
    v: 2 | 1;
    source: "transcript" | "note" | "queue" | "decided" | "endorse" | "morning";
    asked_at: string | null;
    answered_at: string | null;
    locator: {
        path: string;
        byteOffset?: number | undefined;
        sessionId?: string | undefined;
        toolUseId?: string | undefined;
        msgId?: string | undefined;
    } | null;
    session_id: string | null;
    tool_use_id: string | null;
    initiative: string | null;
    header: string | null;
    question: string;
    options: ({
        label: string;
    } | {
        label: string;
        description?: string | undefined;
    })[];
    answer: string | null;
    free_text: string | null;
    answered_by: "owner-terminal" | "owner-remote" | "decider" | "overrule";
    route: "decider" | "owner-now" | "owner-queue" | null;
    prediction: {
        answer: string;
        confidence: number;
        principleIds: string[];
        escalate: boolean;
    } | null;
    unclaimed: boolean;
    pick_type?: "recommended" | "other_option" | "free_text" | "rejected" | "unparsed" | "none" | undefined;
}, {
    key: string;
    v: 2 | 1;
    source: "transcript" | "note" | "queue" | "decided" | "endorse" | "morning";
    asked_at: string | null;
    answered_at: string | null;
    locator: {
        path: string;
        byteOffset?: number | undefined;
        sessionId?: string | undefined;
        toolUseId?: string | undefined;
        msgId?: string | undefined;
    } | null;
    session_id: string | null;
    tool_use_id: string | null;
    initiative: string | null;
    header: string | null;
    question: string;
    options: ({
        label: string;
    } | {
        label: string;
        description?: string | undefined;
    })[];
    recommended: string | null;
    answer: string | null;
    free_text: string | null;
    covers: number | null;
    bulk_from: {
        outcome: "accept" | "amend";
        covers: number | null;
    } | null;
    answered_by: "owner-terminal" | "owner-remote" | "decider" | "overrule";
    route: "decider" | "owner-now" | "owner-queue" | null;
    prediction: {
        answer: string;
        confidence: number;
        principleIds: string[];
        escalate: boolean;
    } | null;
    unclaimed: boolean;
    category?: string | undefined;
    class?: string | undefined;
    pick_type?: "recommended" | "other_option" | "free_text" | "rejected" | "unparsed" | "none" | undefined;
    outcome?: "none" | "accept" | "amend" | "other" | "redirect" | "bulk" | null | undefined;
}>>;
type LedgerRow = z.output<typeof LedgerRowSchema>;
type LedgerRowWire = z.input<typeof LedgerRowSchema>;
type LedgerSourceName = (typeof LEDGER_SOURCES)[number];
type AnsweredBy = (typeof ANSWERED_BY)[number];
type Route = (typeof ROUTES)[number];
type LedgerLocator = z.infer<typeof LedgerLocatorSchema>;
type LedgerOption = z.infer<typeof LedgerOptionSchema>;
type Prediction = z.infer<typeof PredictionSchema>;

/** active-work's v1 `pick_type`, kept so v1 precedent rows still classify. */
declare const PICK_TYPES: readonly ["recommended", "other_option", "free_text", "rejected", "unparsed", "none"];
type PickType = (typeof PICK_TYPES)[number];
/** `bulk` is one answer that accepted several decisions at once; it is never per-item evidence. */
declare const OUTCOMES: readonly ["accept", "amend", "other", "redirect", "none", "bulk"];
type Outcome = (typeof OUTCOMES)[number];
interface OutcomeInput {
    answer: string | null;
    /** Option labels as the asker wrote them, any "recommend" marker included. */
    options: readonly string[];
    recommended: string | null;
    /** A v1 row's pick type; when present it decides everything except amend against redirect. */
    pickType?: PickType;
}
/**
 * Removes the asker's recommendation marker: a bracketed group containing "recommend", or
 * "Recommended" set off by a colon or a spaced dash as prefix or suffix. A negated marker
 * ("not recommended") is not a recommendation and stays.
 */
declare function stripRecommended(label: string): string;
/** The one definition of a recommended option: its label carries a marker `stripRecommended` removes. */
declare function isRecommendedLabel(label: string): boolean;
/** The scored outcome of an answer; null means unparsed or declined, which stays out of scoring. */
declare function classifyOutcome({ answer, options, recommended, pickType }: OutcomeInput): Outcome | null;

/**
 * The owner's exclusion data. The caller loads it from the charter and the owner overlay;
 * this package never reads either.
 */
interface ExclusionPolicy {
    humanOnlyInitiatives: readonly string[];
    /** Project directories and the initiative each belongs to; the deepest match wins. */
    projectInitiatives: readonly {
        dir: string;
        initiative: string;
    }[];
    /** A string matches as a case-insensitive whole word; a RegExp is used as given. */
    personalDataPatterns: readonly (string | RegExp)[];
}
interface ExclusionSubject {
    initiative: string | null;
    cwd?: string | null;
    /** Every initiative the row mentions; any human-only entry excludes it. Never stored. */
    mentionedInitiatives?: readonly string[];
    header: string | null;
    question: string;
    options: readonly {
        label: string;
        description?: string;
    }[];
    answer: string | null;
}
type ExclusionReason = "human-only-initiative" | "human-only-cwd" | "personal-data";
type ExclusionVerdict = {
    excluded: true;
    reason: ExclusionReason;
} | {
    excluded: false;
    initiative: string | null;
    unclaimed: boolean;
};
/** The initiative a working directory belongs to, or null when no project directory holds it. */
declare function initiativeForCwd(cwd: string | null | undefined, policy: Pick<ExclusionPolicy, "projectInitiatives">): string | null;
/** Decide, before a row is written, whether it may enter the ledger and whether it is unclaimed. */
declare function isExcluded(subject: ExclusionSubject, policy: ExclusionPolicy): ExclusionVerdict;

/**
 * The keyword category pass, ported from active-work's `src/precedent/classify.ts`.
 * First match wins, so the order is part of the rule. The decider corrects a row's
 * category when it cites one; this is only the seed.
 */
interface ClassifyInput {
    header: string;
    question: string;
    options: readonly string[];
}
declare function classifyQuestion({ header, question, options }: ClassifyInput): string;

interface ParsedAnswers {
    /** The owner declined the question; such a call is unscored. */
    rejected: boolean;
    answers: Map<string, string>;
}
declare function parseAnswerText(text: string): ParsedAnswers;
/** Exact question first; the harness truncates long questions, so fall back to a 40-char prefix. */
declare function answerFor(answers: ReadonlyMap<string, string>, question: string): string | null;
/** The first option whose label carries a recommendation marker, as the asker wrote it. */
declare function recommendedOption(options: readonly string[]): string | null;

/** Where a source stopped in one of its cursors: a byte offset bound to a hash of the bytes before it. */
interface SourceWatermark {
    offset: number;
    prefixHash: string | null;
}
/** One source's watermarks, keyed by the source's own cursor name (a transcript path, an events table). */
type SourceWatermarks = ReadonlyMap<string, SourceWatermark>;
/** A row the source found, before exclusion. `cwd` and `mentionedInitiatives` feed the exclusion check and are never stored. */
interface SourceCandidate {
    row: LedgerRowWire;
    cwd: string | null;
    mentionedInitiatives?: readonly string[];
}
interface SourceRead {
    candidates: SourceCandidate[];
    /** The cursors this read moved; cursors it did not touch keep their stored watermark. */
    watermarks: Map<string, SourceWatermark>;
    /** Questions seen without an answer yet; the watermark stops before them so the next read retries. */
    pending: number;
    errors: string[];
}
/** The port every ledger source implements. `read` returns only what lies past `since`. */
interface LedgerSource {
    name: string;
    read(since: SourceWatermarks): Promise<SourceRead>;
}

/** Numbered from 3000 so the ledger can share one file with other stores' migration bands. */
declare const LEDGER_MIGRATIONS: Migration[];
/** A row with its insertion sequence: the order rows reached the ledger, whatever their evidence time. */
interface LedgerEntry {
    seq: number;
    row: LedgerRow;
}
interface LedgerRowFilter {
    source?: LedgerSourceName;
    initiative?: string;
}
/**
 * The append-only ledger: one row per key, never updated, plus a watermark per source cursor.
 * Rows are validated through `LedgerRowSchema` on the way in and on the way out.
 */
declare class LedgerStore {
    readonly db: Db;
    private readonly insertStmt;
    private readonly getStmt;
    private readonly watermarks;
    constructor(db: Db);
    /** Writes rows whose key is new and returns how many it wrote; a known key is left untouched. */
    append(rows: readonly LedgerRowWire[]): number;
    private insert;
    get(key: string): LedgerRow | undefined;
    rows(filter?: LedgerRowFilter): LedgerRow[];
    /** Rows inserted after `since`, in insertion order; rowid only grows because the ledger never deletes. */
    entries(since?: number): LedgerEntry[];
    count(): number;
    /** The stored watermarks of one source, keyed by its cursor names. */
    sourceWatermarks(source: string): Map<string, SourceWatermark>;
    advance(source: string, watermarks: SourceWatermarks): void;
    transaction<T>(fn: () => T): T;
}
/** Opens (creating if absent) the ledger database at `dbPath`; `:memory:` works for tests. */
declare function openLedgerStore(dbPath: string): LedgerStore;

interface ExtractSummary {
    source: string;
    /** Candidates the source returned past its watermark. */
    read: number;
    written: number;
    /** Candidates whose key the ledger already held. */
    alreadyIndexed: number;
    /** Admitted rows that accepted a batch of decisions; still written, since they authorize their own items, but never evidence. */
    bulk: number;
    excluded: Record<ExclusionReason, number>;
    pending: number;
    errors: string[];
}
/**
 * Reads one source past its watermark, drops excluded rows before anything is written, appends
 * the rest by key and advances the watermark, all in one transaction.
 */
declare function extractSource(store: LedgerStore, source: LedgerSource, policy: ExclusionPolicy): Promise<ExtractSummary>;

/**
 * The `AskUserQuestion` source, ported from active-work's `src/precedent/transcripts.ts`. It reads
 * Claude Code transcripts directly through session-read, one watermark per transcript file, so it
 * needs no miner graph.
 */
declare const TRANSCRIPT_SOURCE = "transcript";
interface TranscriptFile {
    path: string;
    /** The Claude account the file belongs to; `default` for `~/.claude`. */
    namespace: string;
}
type InitiativeResolver = (cwd: string | null) => string | null | Promise<string | null>;
interface TranscriptSourceOptions {
    /** Defaults to every top-level transcript under every Claude config directory. */
    transcripts?: () => Promise<readonly TranscriptFile[]>;
    /** Defaults to null, leaving exclusion's project-directory mapping to resolve the initiative. */
    resolveInitiative?: InitiativeResolver;
}
/** One question's key; the first keeps v1's call-level key so v1 and v2 rows dedupe together. */
declare function transcriptKey(sessionId: string, toolUseId: string, index?: number): string;
declare function transcriptSource(options?: TranscriptSourceOptions): LedgerSource;

/** The shared domains; a principle that only holds in one initiative uses a per-initiative domain instead. */
declare const PRINCIPLE_DOMAINS: readonly ["agent_ops", "tech_design", "scope_priority", "session_control"];
type PrincipleDomain = (typeof PRINCIPLE_DOMAINS)[number];
/** The `sessionRef` that ties a principle's evidence back to a ledger row. */
declare function ledgerRef(key: string): string;
/** The ledger key behind a `sessionRef`, or null when the ref did not come from the ledger. */
declare function ledgerKeyOf(sessionRef: string | null): string | null;
/** A domain doubles as a file name under the principles directory, so it must be one plain path segment. */
declare function assertDomain(domain: string): string;
interface NewPrinciple {
    rule: string;
    domain: string;
    /** Ledger keys of the owner answers the rule was drawn from. */
    citedKeys: readonly string[];
    isNegative?: boolean;
    reasoning?: string | null;
}
/** A principle is a memory bullet whose category is its domain and whose provenance is ledger keys. */
declare function principleBullet(input: NewPrinciple): NewBullet;
interface Principle {
    id: string;
    domain: string;
    rule: string;
    isNegative: boolean;
    maturity: Maturity;
    score: number;
    /** Newest helpful feedback, or null when no owner answer has confirmed it yet. */
    lastConfirmed: string | null;
    /** Ledger keys that support the rule: its citations, then confirming answers, newest last. */
    examples: string[];
    /** Ledger keys of owner answers that contradicted the rule. */
    counterExamples: string[];
}
/** The view a decider and the rendered docs share: confidence is maturity plus decayed score. */
declare function toPrinciple(bullet: ScoredBullet, events: readonly FeedbackEvent[]): Principle;
/** Every live principle, grouped by domain, scored as of `now`. */
declare function principlesByDomain(store: PlaybookStore, now: Date): Map<string, Principle[]>;

/** The reflector's judgement of one owner answer against one principle. */
interface Citation {
    principleId: string;
    verdict: "agrees" | "contradicts";
    reason?: string;
}
interface PrincipleFeedback {
    principleId: string;
    type: FeedbackType;
    sessionRef: string;
    at: string | undefined;
    reason: string | null;
}
type FeedbackSkip = "decider-answer" | "unclaimed" | "unscored" | "bulk";
type FeedbackMapping = {
    feedback: PrincipleFeedback[];
} | {
    feedback: [];
    skipped: FeedbackSkip;
};
/** Turn one ledger row into helpful or harmful feedback on the principles it bears on. */
declare function feedbackForRow(row: LedgerRow, citations: readonly Citation[]): FeedbackMapping;
interface ApplyFeedbackReport {
    recorded: PrincipleFeedback[];
    duplicate: PrincipleFeedback[];
    unknown: PrincipleFeedback[];
}
/** Record feedback once per principle and ledger key, so re-running a row changes nothing. */
declare function applyFeedback(store: PlaybookStore, feedback: readonly PrincipleFeedback[]): ApplyFeedbackReport;

/** What one condensation run changed in a domain; every list holds principle ids. */
interface DomainChanges {
    added: string[];
    promoted: string[];
    demoted: string[];
    retired: string[];
    confirmed: string[];
    contradicted: string[];
}
interface RunChanges {
    added?: readonly string[];
    retired?: readonly string[];
    maturityChanges?: readonly MaturityChange[];
    feedback?: readonly PrincipleFeedback[];
}
/** Group a run's changes by the domain of each principle, retired ones included. */
declare function changesByDomain(store: PlaybookStore, run: RunChanges): Map<string, DomainChanges>;
/** A one-line quote for a cited example: the owner's answer, or the question when there is none. */
declare function quoteOf(row: Pick<LedgerRow, "answer" | "question">, maxLength?: number): string;
interface RenderOptions {
    /** The quote for a ledger key; examples without one are listed by key alone. */
    quote?: (key: string) => string | undefined;
    /** Newest examples and counter-examples shown per principle. */
    maxExamples?: number;
}
/** Everything above the changelog: the part a run recomputes from the playbook each time. */
declare function renderBody(domain: string, principles: readonly Principle[], options?: RenderOptions): string;
/** One changelog line, or null when the run changed nothing in the domain. */
declare function changelogEntry(version: number, date: string, changes: DomainChanges): string | null;
interface PriorDoc {
    version: number;
    changelog: string[];
}
/** Read the version and changelog back out of a previously rendered doc. */
declare function parsePriorDoc(markdown: string): PriorDoc | null;
interface DomainDoc {
    domain: string;
    version: number;
    markdown: string;
    /** False when the run changed nothing here and the version stayed put. */
    bumped: boolean;
}
interface DomainDocInput {
    domain: string;
    principles: readonly Principle[];
    changes: DomainChanges;
    prior: PriorDoc | null;
    now: Date;
}
/** Render one domain's doc; the version moves only when the run changed something in the domain. */
declare function renderDomainDoc(input: DomainDocInput, options?: RenderOptions): DomainDoc;

interface WriteDocsInput {
    /** The principles directory; the caller resolves it, so tests and owners can point it anywhere. */
    dir: string;
    principles: ReadonlyMap<string, readonly Principle[]>;
    changes: ReadonlyMap<string, DomainChanges>;
    now: Date;
}
interface WrittenDoc extends Omit<DomainDoc, "markdown"> {
    path: string;
}
/** Write `<domain>.md` for every domain that has live principles or changed in this run. */
declare function writePrincipleDocs(input: WriteDocsInput, options?: RenderOptions): WrittenDoc[];

interface AlwaysAskEntry {
    id: string;
    description: string;
}
/** Fixed, never learned and never demotable: no principle and no confidence can answer these. */
declare const ALWAYS_ASK: readonly AlwaysAskEntry[];
declare const HARD_STOP_PREFIX = "hard_stop:";
/** The fixed list plus the charter's hard stops, which the caller passes in; the package never reads a charter. */
declare function alwaysAskList(hardStops: readonly string[]): AlwaysAskEntry[];
/** Whether a question's category or hard-stop id is on the list. */
declare function isAlwaysAsk(id: string, list?: readonly AlwaysAskEntry[]): boolean;

/** One owner answer judged against one live principle of the domain. */
declare const CiteDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"cite">;
    rowKey: z.ZodString;
    principleId: z.ZodString;
    verdict: z.ZodEnum<{
        agrees: "agrees";
        contradicts: "contradicts";
    }>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** A new rule drawn from owner answers; the domain and maturity come from the run, never the reflector. */
declare const ProposeDeltaSchema: z.ZodObject<{
    type: z.ZodLiteral<"propose">;
    rule: z.ZodString;
    citedKeys: z.ZodArray<z.ZodString>;
    isNegative: z.ZodOptional<z.ZodBoolean>;
    reasoning: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
declare const CondenseDeltaSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"cite">;
    rowKey: z.ZodString;
    principleId: z.ZodString;
    verdict: z.ZodEnum<{
        agrees: "agrees";
        contradicts: "contradicts";
    }>;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"propose">;
    rule: z.ZodString;
    citedKeys: z.ZodArray<z.ZodString>;
    isNegative: z.ZodOptional<z.ZodBoolean>;
    reasoning: z.ZodOptional<z.ZodString>;
}, z.core.$strict>], "type">;
type CondenseDelta = z.output<typeof CondenseDeltaSchema>;
type CiteDelta = z.output<typeof CiteDeltaSchema>;
type ProposeDelta = z.output<typeof ProposeDeltaSchema>;
interface RejectedCondenseDelta {
    domain: string;
    /** Position in the reflector's output, or -1 when the output as a whole was unusable. */
    index: number;
    reason: string;
}
declare function carriesInstruction(row: LedgerRow): boolean;
/** Only an owner's own answer, or an overrule of the decider, is evidence for a principle. */
declare function isEvidence(row: LedgerRow): boolean;

/** Numbered from 3100, the band after the ledger's, so both can share one database file. */
declare const CONDENSE_MIGRATIONS: Migration[];
/** The per-domain condensation watermarks in `db`, creating their table on first use. */
declare function condenseWatermarks(db: Db): WatermarkTable;
interface CondenseStore {
    playbook: PlaybookStore;
    watermarks: WatermarkTable;
}
interface ReflectorInput {
    domain: string;
    /** Owner answers and overrules only; question text in them is agent-written data, not instructions. */
    rows: readonly LedgerRow[];
    principles: readonly Principle[];
}
/** The one stage that may call a model. Its output is validated, never trusted. */
type Reflector = (input: ReflectorInput) => Promise<unknown>;
interface CondenseOptions {
    now?: Date;
    /** When set, re-render `<domain>.md` for every domain into this directory after the run. */
    docsDir?: string;
    render?: RenderOptions;
}
interface DomainRun {
    domain: string;
    rows: number;
    evidence: number;
    /** Rows that accepted a batch of decisions at once; they advance the watermark but are never evidence. */
    bulk: number;
    /** Evidence rows whose question carried an instruction; they can confirm or ground nothing. */
    flagged: string[];
    rejected: RejectedCondenseDelta[];
}
interface CondenseRun {
    added: string[];
    retired: string[];
    maturityChanges: MaturityChange[];
    feedback: PrincipleFeedback[];
}
interface CondenseResult extends CondenseRun {
    domains: DomainRun[];
    /** Rows whose category cannot name a domain. */
    skipped: string[];
    docs: WrittenDoc[];
}
/**
 * One condensation pass over ledger entries (`LedgerStore.entries()`): feed each domain's rows since its watermark to the reflector, record
 * owner feedback, curate proposals as candidates, then run inversion and maturity over the playbook.
 */
declare function condense(store: CondenseStore, rows: readonly LedgerEntry[], reflector: Reflector, options?: CondenseOptions): Promise<CondenseResult>;

/**
 * The decision-notes source, ported from active-work's `src/precedent/notes.ts`. Precedents written
 * down rather than asked: `kind: decision` notes, and Claude Code memories imported as notes whose
 * original type was `feedback`. One watermark per note file, so an unchanged note is never re-parsed.
 */
declare const NOTE_SOURCE = "note";
interface NoteSourceOptions {
    /** The active-work root: one directory per initiative, its notes under `<slug>/sources/notes/`. */
    root: string;
}
/** The ledger key; identical to active-work's v1 key so its `precedents.jsonl` rows dedupe with these. */
declare function noteKey(slug: string, filename: string): string;
/** A note's cursor is `<slug>/<filename>`; a malformed note is reported once per content change. */
declare function noteSource(options: NoteSourceOptions): LedgerSource;

/**
 * agent-chat's unlock table, ported from `src/broker/decisions.ts` and held to it by
 * `unlock.test.ts`. Every match errs towards the owner: a false positive costs one
 * answer, a false negative is an unlock decided by a model.
 */
/** Categories a decider may answer; everything else stays with the owner. */
declare const DECIDABLE_CATEGORIES: readonly string[];
/** Categories that are themselves unlock-table rows, so no mode can raise them. */
declare const UNLOCK_CATEGORIES: readonly string[];
/** The unlock-table row a text touches, or undefined when it touches none. */
declare function unlockTableRow(text: string): string | undefined;
type UnlockCheck = {
    ok: true;
} | {
    ok: false;
    code: "not_decidable" | "unlock_table";
    reason: string;
};
/** agent-chat's `checkDecision` minus its citation check: whether a decider may answer at all. */
declare function checkUnlock(question: string, answer: string, category: string): UnlockCheck;

/**
 * The AskUserQuestion contract as a pure lint. An owner question must be one decision (AQ1), name
 * what each id is (AQ2), say what holds today (AQ3), carry its substance rather than point at a
 * file (AQ4) and lead with a recommendation (AQ5). No model call: every rule is a text pattern, and
 * each finding's evidence names the trigger it matched so a false positive is easy to see.
 */
declare const ASK_RULES: readonly ["AQ1", "AQ2", "AQ3", "AQ4", "AQ5"];
type AskRule = (typeof ASK_RULES)[number];
interface AskOption {
    label: string;
    description?: string;
}
interface AskQuestion {
    header?: string;
    question: string;
    options?: readonly AskOption[];
    recommended?: string | null;
}
/** One broken rule; other lints of owner-facing text (`lintPrSection`) reuse it with their own rule ids. */
interface AskFinding<Rule extends string = AskRule> {
    rule: Rule;
    evidence: string;
}
/** One item of a Morning list or a plan's owner questions, with its findings. */
interface AskItemFindings {
    /** The item's own id as written: `vc-65.1`, `ws-9, A1`, or a plan entry's number. */
    id: string;
    text: string;
    findings: AskFinding[];
}
/** Test hook: lets a test assert how much text the id-context windows read, instead of timing the lint. */
interface AskLintStats {
    windowChars: number;
}
/** Every contract rule the question breaks, in rule order; an empty list means it passes. */
declare function lintAsk(question: AskQuestion, stats?: AskLintStats): AskFinding[];
/** Lints each `[id]` or `N.` item of a Morning list, the item's own id excluded from its text. */
declare function lintMorningList(text: string): AskItemFindings[];
/** Lints each entry of every "Owner questions" section of a plan; an unnumbered bullet gets its position as its id. */
declare function lintOwnerQuestions(planText: string): AskItemFindings[];

/**
 * The owner PR section contract as a pure lint, in the shape of `lintAsk`. A section about one PR
 * carries the PR URL (PR1), says what the PR does in at least two sentences (PR2), says why it
 * reaches the owner with a gate class and a rule id (PR3), lists a pro and a con (PR4), and for a
 * UI PR pairs a before and an after image per changed story or says why there are none (PR5).
 */

declare const PR_SECTION_RULES: readonly ["PR1", "PR2", "PR3", "PR4", "PR5"];
type PrSectionRule = (typeof PR_SECTION_RULES)[number];
type PrSectionFinding = AskFinding<PrSectionRule>;
/** Every contract rule an owner PR section breaks, in rule order; an empty list means it passes. */
declare function lintPrSection(section: string): PrSectionFinding[];

/** The confidence a reply needs in a category with no policy row (plan 3.3). */
declare const DEFAULT_MIN_CONFIDENCE = 0.8;
declare const DecidePrincipleSchema: z.ZodObject<{
    id: z.ZodString;
    rule: z.ZodString;
    confidence: z.ZodNumber;
    examples: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
declare const DecidePrecedentSchema: z.ZodObject<{
    key: z.ZodString;
    quote: z.ZodString;
}, z.core.$strip>;
/** What the decider is shown: one question plus the principles and precedents it may cite. */
declare const DecideInputSchema: z.ZodObject<{
    question: z.ZodString;
    header: z.ZodOptional<z.ZodString>;
    options: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    recommended: z.ZodNullable<z.ZodString>;
    category: z.ZodString;
    initiative: z.ZodNullable<z.ZodString>;
    context: z.ZodString;
    principles: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        rule: z.ZodString;
        confidence: z.ZodNumber;
        examples: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    precedents: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        quote: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** What the decider answers; `validate` decides whether it may stand. */
declare const DecideReplySchema: z.ZodObject<{
    answer: z.ZodString;
    optionIndex: z.ZodNullable<z.ZodNumber>;
    confidence: z.ZodNumber;
    principleIds: z.ZodArray<z.ZodString>;
    escalate: z.ZodBoolean;
    escalateReason: z.ZodOptional<z.ZodString>;
    reversible: z.ZodString;
}, z.core.$strip>;
type DecidePrinciple = z.infer<typeof DecidePrincipleSchema>;
type DecidePrecedent = z.infer<typeof DecidePrecedentSchema>;
type DecideInput = z.infer<typeof DecideInputSchema>;
type DecideReply = z.infer<typeof DecideReplySchema>;
/** The threshold slice of a category's policy row; fuller rows from the router are assignable. */
interface CategoryThreshold {
    minConfidence?: number;
}
interface DecidePolicy {
    categories?: Readonly<Record<string, CategoryThreshold>>;
}
type DecideValidation = {
    ok: true;
    reply: DecideReply;
} | {
    ok: false;
    errors: string[];
};
/** JSON Schema for both halves of the contract, for model prompts and non-TypeScript callers. */
declare function decideJsonSchemas(): {
    input: Record<string, unknown>;
    reply: Record<string, unknown>;
};
/** Rows match on `policyCategory`, so `Tech Design` reads `tech_design`; when several spellings match, the strictest threshold wins. */
declare function minConfidenceFor(category: string, policy: DecidePolicy): number;
/** Checks a raw reply against its input; a bad reply is a typed failure, never a throw. */
declare function validate(reply: unknown, input: DecideInput, policy?: DecidePolicy): DecideValidation;

declare const DECIDER_MODES: readonly ["off", "shadow", "auto"];
type DeciderMode = (typeof DECIDER_MODES)[number];
declare const CategoryPolicySchema: z.ZodObject<{
    category: z.ZodString;
    mode: z.ZodDefault<z.ZodEnum<{
        off: "off";
        shadow: "shadow";
        auto: "auto";
    }>>;
    minConfidence: z.ZodDefault<z.ZodNumber>;
    windowDays: z.ZodDefault<z.ZodNumber>;
    minSamples: z.ZodDefault<z.ZodNumber>;
    minAgreement: z.ZodDefault<z.ZodNumber>;
    maxMissedRedirects: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
type CategoryPolicy = z.output<typeof CategoryPolicySchema>;
declare const RoutingPolicySchema: z.ZodObject<{
    categories: z.ZodDefault<z.ZodArray<z.ZodObject<{
        category: z.ZodString;
        mode: z.ZodDefault<z.ZodEnum<{
            off: "off";
            shadow: "shadow";
            auto: "auto";
        }>>;
        minConfidence: z.ZodDefault<z.ZodNumber>;
        windowDays: z.ZodDefault<z.ZodNumber>;
        minSamples: z.ZodDefault<z.ZodNumber>;
        minAgreement: z.ZodDefault<z.ZodNumber>;
        maxMissedRedirects: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>>;
    hardStops: z.ZodDefault<z.ZodArray<z.ZodString>>;
    humanOnlyInitiatives: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
type RoutingPolicy = z.output<typeof RoutingPolicySchema>;
/** Always-ask and unlock-table categories: their mode is `off` and nothing raises it. */
declare function isLockedCategory(category: string, list?: readonly AlwaysAskEntry[]): boolean;
/** A parsed policy with category names normalized and every locked one forced to `off`, so stored data cannot raise one. */
declare function parseRoutingPolicy(input: unknown): RoutingPolicy;
/** The category's row, or the defaults: every category starts in shadow, locked ones off. */
declare function categoryPolicy(policy: RoutingPolicy, category: string): CategoryPolicy;
/** The thresholds `validate` reads, keyed the way `categoryPolicy` folds rows, so both agree on a category's minConfidence. */
declare function decidePolicyFrom(policy: RoutingPolicy): DecidePolicy;
/** A new policy with the category at `mode`; raising a locked category above `off` throws. */
declare function setCategoryMode(policy: RoutingPolicy, category: string, mode: DeciderMode): RoutingPolicy;

interface RouteQuestion {
    category: string;
    question: string;
    header?: string | null;
    options: readonly string[];
    initiative?: string | null;
}
interface RouteContext {
    /** The asker's `AGENT_CHAT_AGENT_ID`; absent means an attended session. */
    agentId?: string | null;
    /** The asker cannot continue without the answer. */
    blocking?: "parked" | "none";
    /** The asker has other work it can do while it waits. */
    otherWork?: boolean;
}
interface RouteDecision {
    route: Route;
    shadow: boolean;
    rule: 1 | 2 | 3 | 4;
    reason: string;
}
/** Pure rule table, first match wins; never calls a model. A decider may narrow `decider`, never widen an owner route. */
declare function route(question: RouteQuestion, policy: RoutingPolicy, ctx?: RouteContext): RouteDecision;

/** Overrules within this many days that drop an auto category back to shadow (plan 3.4). */
declare const DEMOTE_OVERRULES = 2;
declare const DEMOTE_WINDOW_DAYS = 7;
type Verdict = "agree" | "disagree" | "missed-redirect";
interface CategoryScore {
    category: string;
    samples: number;
    agreed: number;
    /** `agreed / samples`, or null with no samples. */
    agreement: number | null;
    missedRedirects: number;
    /** Agreement of always taking the asker's recommendation, the bar the decider must clear by a margin. */
    baseline: number | null;
    overrules: number;
    /** In-window bulk owner rows: asked in a form nobody can learn from, so they carry no sample. */
    bulk: number;
    recommendAuto: boolean;
    demote: boolean;
}
interface ScoreOptions {
    policy: RoutingPolicy;
    now: () => Date;
}
/** The prediction stored on each ledger row, keyed by row key. */
declare function ledgerPredictions(ledger: readonly LedgerRow[]): Map<string, Prediction>;
/** Amend counts as agreement with the option it amended; a redirect agrees only when the decider escalated. */
declare function verdict(row: LedgerRow, prediction: Prediction): Verdict;
/**
 * True when the category clears every graduation threshold in its policy row and has not drawn
 * enough recent overrules to be demoted, so a score never recommends auto for what it just demoted.
 */
declare function recommendsAuto(score: Pick<CategoryScore, "samples" | "agreement" | "missedRedirects" | "overrules">, policy: CategoryPolicy): boolean;
/** Per-category shadow agreement over each policy window, with graduation and demotion verdicts; pure. */
declare function score(predictions: ReadonlyMap<string, Prediction>, ledger: readonly LedgerRow[], options: ScoreOptions): CategoryScore[];
/** Demotion is automatic: every demoted category goes back to shadow. Graduation stays a recommendation. */
declare function applyDemotions(policy: RoutingPolicy, scores: readonly CategoryScore[]): RoutingPolicy;

/**
 * The Morning owner-answers source. A day's `<date>.md` lists numbered items, each opening with a
 * recommendation; `<date>-owner-answers.md` answers them by item number. An answer joins to its item
 * by number alone. A line with no readable number is counted, and so is a number that names no item
 * or more than one: a join is never guessed.
 */
declare const MORNING_SOURCE = "morning";
interface MorningItem {
    /** The ids the list gives the item, normalized: `hs-25` is `hs25`, `A5` is `a5`, `30.` is `30`, `vc-65.1` is `vc65.1`. */
    ids: string[];
    question: string;
    recommended: string | null;
}
interface MorningAnswer {
    /** One normalized id per number the line names; a bare number stays a bare number. */
    ids: string[];
    text: string;
    /** Where the line starts in the answers file. */
    byteOffset: number;
    /** The text goes on to name more items ("1 and 2: yes"), so one answer cannot be assigned to one. */
    namesMore: boolean;
}
interface ParsedAnswerLines {
    answers: MorningAnswer[];
    unparseable: number;
}
interface MorningCounts {
    unparseable: number;
    /** Answer ids that name no item in the day's list. */
    unmatched: number;
    /** Bare answer numbers that fit more than one item. */
    ambiguous: number;
    /** Answers whose id an earlier line in the same file already answered, under any id of the item; the first stands. */
    duplicate: number;
}
interface MorningJoin {
    rows: LedgerRowWire[];
    /** The item each row answers, aligned by index with `rows`. */
    items: MorningItem[];
    counts: MorningCounts;
}
interface MorningFileSystem {
    readdir(dir: string): Promise<string[]>;
    readFile(file: string): Promise<Buffer>;
}
type MorningDayCounts = MorningCounts & {
    /** Rows that did not get exactly one initiative. */
    unresolved: number;
};
/** Every initiative the item names; empty when it names none. */
type MorningInitiativeResolver = (item: MorningItem) => readonly string[] | Promise<readonly string[]>;
interface MorningSourceOptions {
    /** The directory holding `<date>.md` and `<date>-owner-answers.md` pairs. */
    dir: string;
    fs?: MorningFileSystem;
    /** Absent: every row stays unclaimed. A throw leaves the day unread and reported in errors. */
    resolveInitiatives?: MorningInitiativeResolver;
    /** Receives each answers file's counts as it is read. */
    onCounts?: (date: string, counts: MorningDayCounts) => void;
}
/** Task ids in text, in order, deduplicated. */
declare function taskIdsIn(text: string): string[];
/** A resolver from an id lookup: the union of lookup(id) over the task ids in the item's question. */
declare function initiativesOfTaskIds(lookup: (taskId: string) => readonly string[]): MorningInitiativeResolver;
/** Items start at an unindented `[id]` or `N.` line; indented lines and anything else are not items. */
declare function parseMorningList(text: string): MorningItem[];
/** Answer lines are `<ids>: <text>` or `<ids> <text>`; headings, blanks and lines with no leading number are skipped or counted. */
declare function parseOwnerAnswers(text: string): ParsedAnswerLines;
/** Pure join of one day's list and answers; counts say what was left out and why. A bare number joins only a bare-numbered item. */
declare function joinMorning(date: string, listText: string, answersText: string, answersPath: string): MorningJoin;
/** One cursor per answers file; a day whose list is missing is reported and retried, never joined blind. */
declare function morningSource(options: MorningSourceOptions): LedgerSource;

export { ALWAYS_ASK, ANSWERED_BY, ASK_RULES, type AlwaysAskEntry, type AnsweredBy, type ApplyFeedbackReport, type AskFinding, type AskItemFindings, type AskLintStats, type AskOption, type AskQuestion, type AskRule, CONDENSE_MIGRATIONS, type CategoryPolicy, CategoryPolicySchema, type CategoryScore, type CategoryThreshold, type Citation, type CiteDelta, CiteDeltaSchema, type ClassifyInput, type CondenseDelta, CondenseDeltaSchema, type CondenseOptions, type CondenseResult, type CondenseRun, type CondenseStore, DECIDABLE_CATEGORIES, DECIDER_MODES, DEFAULT_MIN_CONFIDENCE, DEMOTE_OVERRULES, DEMOTE_WINDOW_DAYS, type DecideInput, DecideInputSchema, type DecidePolicy, type DecidePrecedent, DecidePrecedentSchema, type DecidePrinciple, DecidePrincipleSchema, type DecideReply, DecideReplySchema, type DecideValidation, type DeciderMode, type DomainChanges, type DomainDoc, type DomainDocInput, type DomainRun, type ExclusionPolicy, type ExclusionReason, type ExclusionSubject, type ExclusionVerdict, type ExtractSummary, type FeedbackMapping, type FeedbackSkip, HARD_STOP_PREFIX, type InitiativeResolver, LEDGER_MIGRATIONS, LEDGER_SOURCES, type LedgerEntry, type LedgerLocator, LedgerLocatorSchema, type LedgerOption, LedgerOptionSchema, type LedgerRow, type LedgerRowFilter, LedgerRowSchema, type LedgerRowWire, type LedgerSource, type LedgerSourceName, LedgerStore, MORNING_SOURCE, type MorningAnswer, type MorningCounts, type MorningDayCounts, type MorningFileSystem, type MorningInitiativeResolver, type MorningItem, type MorningJoin, type MorningSourceOptions, NOTE_SOURCE, type NewPrinciple, type NoteSourceOptions, OUTCOMES, type Outcome, type OutcomeInput, PICK_TYPES, PRINCIPLE_DOMAINS, PR_SECTION_RULES, type ParsedAnswerLines, type ParsedAnswers, type PickType, type PrSectionFinding, type PrSectionRule, type Prediction, PredictionSchema, type Principle, type PrincipleDomain, type PrincipleFeedback, type PriorDoc, type ProposeDelta, ProposeDeltaSchema, ROUTES, type Reflector, type ReflectorInput, type RejectedCondenseDelta, type RenderOptions, type Route, type RouteContext, type RouteDecision, type RouteQuestion, type RoutingPolicy, RoutingPolicySchema, type RunChanges, type ScoreOptions, type SourceCandidate, type SourceRead, type SourceWatermark, type SourceWatermarks, TRANSCRIPT_SOURCE, type TranscriptFile, type TranscriptSourceOptions, UNLOCK_CATEGORIES, type UnlockCheck, type Verdict, type WriteDocsInput, type WrittenDoc, alwaysAskList, answerFor, applyDemotions, applyFeedback, assertDomain, carriesInstruction, categoryPolicy, changelogEntry, changesByDomain, checkUnlock, classifyOutcome, classifyQuestion, condense, condenseWatermarks, decideJsonSchemas, decidePolicyFrom, extractSource, feedbackForRow, initiativeForCwd, initiativesOfTaskIds, isAlwaysAsk, isEvidence, isExcluded, isLockedCategory, isRecommendedLabel, joinMorning, ledgerKeyOf, ledgerPredictions, ledgerRef, lintAsk, lintMorningList, lintOwnerQuestions, lintPrSection, minConfidenceFor, morningSource, noteKey, noteSource, openLedgerStore, parseAnswerText, parseMorningList, parseOwnerAnswers, parsePriorDoc, parseRoutingPolicy, principleBullet, principlesByDomain, quoteOf, recommendedOption, recommendsAuto, renderBody, renderDomainDoc, route, score, setCategoryMode, stripRecommended, taskIdsIn, toPrinciple, transcriptKey, transcriptSource, unlockTableRow, validate, verdict, writePrincipleDocs };

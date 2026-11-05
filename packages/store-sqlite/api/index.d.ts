import Database from 'better-sqlite3';

type Db = Database.Database;
interface OpenOptions {
    readonly?: boolean;
    /**
     * The highest migration version this runtime knows. When set, opening a database
     * stamped past it throws `SchemaTooNewError` instead of quietly proceeding.
     */
    schemaVersion?: number;
    /** WAL keeps readers from blocking a writer. On by default for file databases. */
    wal?: boolean;
    /** SQLite leaves foreign keys off per connection; the kit turns them on. */
    foreignKeys?: boolean;
}
/** Open (creating if absent) a database with the kit's pragmas. `:memory:` works for tests. */
declare function openDatabase(dbPath: string, options?: OpenOptions): Db;
/** The one table name the kit reserves: every migration a store applies is recorded here. */
declare const MIGRATION_TABLE_NAME = "_migration";
/**
 * Thrown when a database carries a schema version this runtime has never applied.
 *
 * Adapted from beads (MIT), `internal/storage/embeddeddolt/store.go`: a stale binary whose
 * migrations silently no-op dies later on a column the newer schema dropped, a long way
 * from the cause.
 */
declare class SchemaTooNewError extends Error {
    readonly storedVersion: number;
    readonly knownVersion: number;
    constructor(storedVersion: number, knownVersion: number);
}
/**
 * Refuse a database stamped newer than `knownVersion`. A no-op on one that has never been
 * migrated, so a fresh file opens normally.
 *
 * Only a caller that owns the whole schema can name that version: a store layering its own
 * migrations onto a shared database sees one band of versions, not the top. That is why
 * this is opt-in rather than a check inside `runMigrations`.
 */
declare function assertSchemaVersion(db: Db, knownVersion: number): void;
/** ISO-8601 with milliseconds, the timestamp shape every kit table stores. */
declare function nowIso(): string;
/** SQL expression producing the same shape as `nowIso()` inside the database. */
declare const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
declare function hasTable(db: Db, table: string): boolean;
declare function hasColumn(db: Db, table: string, column: string): boolean;
/** Double-quote an identifier so table factories can take caller-chosen names safely. */
declare function quoteIdent(name: string): string;

interface Migration {
    /** Positive, unique, applied in ascending order. */
    version: number;
    name?: string;
    up: (db: Db) => void;
}
declare class MigrationIdentityError extends Error {
    readonly version: number;
    readonly recordedName: string;
    readonly declaredName: string;
    constructor(version: number, recordedName: string, declaredName: string);
}
declare function appliedVersions(db: Db): number[];
/**
 * Apply every migration not yet recorded in `_migration`, each in its own
 * transaction so a failure leaves the database at the last good version.
 * Returns the versions applied this call.
 */
declare function runMigrations(db: Db, migrations: readonly Migration[]): number[];

/**
 * The cross-domain identity grammar: `<kind>:<id>`, where `kind` is a short
 * lowercase token and `id` is anything the domain needs (paths, `repo#node`,
 * numbers). Every domain mints refs for its own entities and the shared edge
 * table links them, so `session:abc` can point at `codewatch:repo#src/a.ts::Foo`
 * without either side knowing the other's schema.
 */
interface ParsedRef {
    kind: string;
    id: string;
}
declare function ref(kind: string, id: string): string;
declare function parseRef(value: string): ParsedRef;
declare function isRef(value: unknown): value is string;
/** A typed minter for one kind: `const session = refKind("session"); session("abc")`. */
declare function refKind(kind: string): (id: string) => string;

/** Which kit tables a store wants, by name override or `true` for the default name. */
interface KitSelection {
    snapshot?: string | true;
    entitySnap?: string | true;
    entity?: string | true;
    edge?: string | true;
    cacheBlob?: string | true;
    spanFts?: string | true;
    watermark?: string | true;
}
/** The DDL for a selection of kit tables, in dependency-safe order. Every statement is `IF NOT EXISTS`. */
declare function kitDdl(selection: KitSelection): string;
/** A migration that installs the selected kit tables, for use as a store's version 1. */
declare function kitMigration(version: number, selection: KitSelection, name?: string): Migration;

/**
 * Interval bi-temporal edge table: `t_valid`/`t_invalid` is when the relation
 * held in the world, `t_created`/`t_expired` is when this row was believed.
 * Corrections expire a row and insert a replacement, never delete, so history
 * stays auditable while partial indexes keep live lookups cheap. This is the
 * cross-domain outer graph; relation names are free strings by design.
 */
interface EdgeTableOptions {
    name?: string;
}
declare function edgeTableDdl({ name }?: EdgeTableOptions): string;
interface EdgeInput {
    sourceRef: string;
    relation: string;
    targetRef: string;
    tValid?: string;
    tInvalid?: string | null;
    factId?: number | null;
    confidence?: number;
    attrs?: Record<string, unknown> | null;
}
interface EdgeRow {
    edgeId: number;
    sourceRef: string;
    relation: string;
    targetRef: string;
    tValid: string;
    tInvalid: string | null;
    tCreated: string;
    tExpired: string | null;
    factId: number | null;
    confidence: number;
    attrs: Record<string, unknown> | null;
}
/** Prepared helpers over one edge table. Construct once per connection. */
declare class EdgeTable {
    private readonly insertStmt;
    private readonly expireStmt;
    private readonly currentStmt;
    private readonly fromStmt;
    private readonly toStmt;
    private readonly supersedeTxn;
    constructor(db: Db, { name }?: EdgeTableOptions);
    /** Assert an edge. A live identical edge is left alone (idempotent re-ingest). Returns true when inserted. */
    assert(edge: EdgeInput): boolean;
    /** Retract the current belief in an edge (invalidate, never delete). Returns true when one was live. */
    expire(sourceRef: string, relation: string, targetRef: string, at?: string): boolean;
    /** Replace the live edge with a corrected one in a single step; a failed insert rolls the expire back. */
    supersede(edge: EdgeInput, at?: string): void;
    current(sourceRef: string, relation: string, targetRef: string): EdgeRow | undefined;
    from(sourceRef: string): EdgeRow[];
    to(targetRef: string): EdgeRow[];
}

/**
 * Two entity shapes, because the projects that converged on "kind + name +
 * parent + JSON attrs" genuinely diverge on time. Snapshot-scoped rows are
 * right when a whole population is re-indexed together (a code graph);
 * interval rows are right when facts change one at a time (memory, sessions).
 */
interface TableName {
    name?: string;
}
/** Snapshot-scoped entity: every row belongs to one snapshot. */
declare function entitySnapTableDdl({ name }?: TableName): string;
/** The snapshot registry the snapshot-scoped tables key on. */
declare function snapshotTableDdl({ name }?: TableName): string;
/**
 * Current-state entity keyed by its cross-domain ref, with soft expiry. Not
 * interval bi-temporal like the edge table: one row per ref, an upsert
 * overwrites it in place and keeps no history, and a revived ref keeps its
 * first `t_valid` and `t_created`.
 */
declare function entityTableDdl({ name }?: TableName): string;
interface EntityInput {
    ref: string;
    kind: string;
    name?: string | null;
    parentRef?: string | null;
    attrs?: Record<string, unknown> | null;
    tValid?: string;
}
interface EntityRow {
    ref: string;
    kind: string;
    name: string | null;
    parentRef: string | null;
    attrs: Record<string, unknown> | null;
    tValid: string;
    tInvalid: string | null;
    tCreated: string;
    tExpired: string | null;
}
/** Prepared helpers over one current-state entity table. */
declare class EntityTable {
    private readonly upsertStmt;
    private readonly getStmt;
    private readonly expireStmt;
    private readonly byKindStmt;
    constructor(db: Db, { name }?: TableName);
    /** Insert or overwrite the entity; a previously expired ref comes back live with its original `t_valid`. */
    upsert(entity: EntityInput): void;
    get(ref: string): EntityRow | undefined;
    expire(ref: string, at?: string): boolean;
    listByKind(kind: string): EntityRow[];
}

/**
 * Content-addressed cache for anything that is a pure function of some text
 * and a model: embeddings, summaries, extracted structure. Keyed by
 * `(namespace, model, content_hash)`, so unchanged inputs across re-indexes
 * are cache hits rather than re-computation, and identical text is stored once.
 */
interface CacheBlobOptions {
    name?: string;
}
declare function cacheBlobTableDdl({ name }?: CacheBlobOptions): string;
declare function contentHashOf(text: string): string;
interface CacheKey {
    namespace: string;
    model: string;
    /** Either the raw text (hashed for you) or a precomputed `contentHash`. */
    text?: string;
    contentHash?: string;
}
interface CacheHit {
    value: Buffer;
    meta: Record<string, unknown> | null;
}
declare class CacheBlobTable {
    private readonly getStmt;
    private readonly putStmt;
    private readonly countStmt;
    constructor(db: Db, { name }?: CacheBlobOptions);
    get(key: CacheKey): CacheHit | undefined;
    /** Store once; a second put for the same key is a no-op. Returns true when written. */
    put(key: CacheKey, value: Buffer | string, meta?: Record<string, unknown>): boolean;
    /** Get, or compute and store. The compute runs only on a miss. */
    getOrCompute(key: CacheKey, compute: () => Buffer | string, meta?: Record<string, unknown>): Buffer;
    count(namespace: string, model: string): number;
}

/**
 * Full-text search without storing the text. `searchable_span` holds only a
 * locator into the source (a byte range in a transcript, a file, a blob); the
 * FTS5 table is genuinely contentless (`content=''`), so text is streamed in
 * at index time and discarded. Reads MUST join through the span table: a
 * contentless FTS5 table cannot delete rows without their original text, so
 * purges strand FTS rows, and the join is what makes those orphans invisible.
 */
interface SpanFtsOptions {
    /** Base name; tables are `<name>_span` and `<name>_fts`. */
    name?: string;
    /**
     * Create the FTS table with `contentless_delete=1` (SQLite 3.43+), so purges
     * delete FTS rows instead of stranding them. Default false: the table and its
     * orphan behaviour stay as they were.
     */
    contentlessDelete?: boolean;
}
declare function spanFtsTablesDdl({ name, contentlessDelete }?: SpanFtsOptions): string;
interface SpanInput {
    /** The entity this text belongs to, e.g. `session:abc`. */
    ownerRef: string;
    /** Which part of the owner, e.g. `prompt` or `tool_result`. */
    field: string;
    /** Transcript or file id the byte range is relative to. */
    sourceId: number;
    byteOffset: number;
    byteLength: number;
}
interface SpanHit extends SpanInput {
    spanId: number;
    /** FTS5 bm25 rank; lower is better. */
    rank: number;
}
/**
 * Narrow a search to one class of owner, so one class cannot flood a result set.
 *
 * A span table that holds several entity classes holds them in wildly different
 * volumes. Measured on active-work's graph: 92,713 transcript spans against
 * 1,569 note spans, 59 to 1. Ranking one pooled query returns transcript
 * chatter and the notes never surface, so the fix is a separate ranked list per
 * class, which needs a way to ask for one class.
 *
 * `ownerPrefix` and `fields` are both needed, not either. active-work keys both
 * a mined transcript and a workspace session record under `session:`, and they
 * are separable only by field — `body` is the record, `prompt` and the
 * `tool_*` fields are the transcript. A prefix-only filter would put 92,713
 * transcript spans into the records' list and look like it was working.
 */
interface SpanScope {
    /** Match owners whose ref starts with this, e.g. `note:`. A range scan, so the owner index applies. */
    ownerPrefix?: string;
    /** Match only these fields, e.g. `["title", "body"]`. Empty means no field matches. */
    fields?: string[];
}
declare class SpanFtsTables {
    private readonly db;
    private readonly tableNames;
    private readonly insertSpan;
    private readonly findSpan;
    private readonly insertFts;
    private readonly hasFtsRow;
    private readonly searchStmt;
    /** One prepared statement per scope shape, since the predicate list varies. */
    private readonly scopedSearchStmts;
    private readonly deleteAllFts;
    private readonly deleteSpansStmt;
    private readonly deleteSourceSpansStmt;
    private readonly purgeOwnerTxn;
    private readonly purgeSourceTxn;
    private readonly countSpans;
    private readonly countFts;
    private readonly indexTxn;
    constructor(db: Db, { name, contentlessDelete }?: SpanFtsOptions);
    /**
     * Index `text` for a span, storing only the locator. Returns the span id.
     *
     * Re-indexing a span that still has its FTS row is a no-op; re-indexing one
     * whose row `clearIndex` removed puts the row back, which is what makes
     * clear-then-re-stream a rebuild. Only the conflict path pays the rowid probe.
     */
    index(span: SpanInput, text: string): number;
    /**
     * FTS5 MATCH, joined through the span table so stranded FTS rows never surface.
     *
     * `scope` narrows to one class of owner; `limit` is applied after it, so a
     * scoped search returns its own top-N rather than whatever survives the
     * filter out of a global top-N.
     */
    search(query: string, limit?: number, scope?: SpanScope): SpanHit[];
    /**
     * Prepared statement for one scope shape, cached.
     *
     * Cached by shape rather than by values, because a product registers a fixed
     * handful of class retrievers and then queries them for the life of the
     * process. Keyed on the field *count* and whether a prefix is present, which
     * is everything that changes the SQL.
     */
    private scopedStatement;
    /**
     * Drop an owner's spans. Without `contentlessDelete` their FTS rows become
     * orphans, hidden by the join, until `clearIndex` and a re-stream.
     */
    purgeOwner(ownerRef: string): number;
    /** Drop every span of one source (transcript or file), with the same FTS behaviour as `purgeOwner`. */
    purgeSource(sourceId: number): number;
    /** Fraction of FTS rows with no span behind them; a high value means it is time to `clearIndex` and re-stream. */
    orphanRatio(): number;
    /**
     * Empty the FTS index, keeping every span row. Re-streaming each surviving
     * span's text through `index` then rebuilds it with the same span ids.
     */
    clearIndex(): void;
}

/**
 * Incremental-ingest bookkeeping for any append-mostly source: where the reader
 * stopped, a hash of what it already consumed (so a rewrite is detected rather
 * than silently re-read from the wrong offset), and the size/mtime/content-hash
 * triple that makes "source gone or altered" a reportable state.
 */
type WatermarkStatus = "ok" | "missing" | "hash_mismatch" | "quarantined";
interface WatermarkOptions {
    name?: string;
}
declare function watermarkTableDdl({ name }?: WatermarkOptions): string;
interface WatermarkRow {
    sourceId: number;
    sourceKey: string;
    lastOffset: number;
    prefixHash: string | null;
    lastIndexedAt: string | null;
    fileSize: number | null;
    fileMtime: string | null;
    contentHash: string | null;
    status: WatermarkStatus;
    statusReason: string | null;
}
interface WatermarkAdvance {
    lastOffset: number;
    prefixHash?: string | null;
    fileSize?: number | null;
    fileMtime?: string | null;
    /** Null keeps any previously stored hash; computing it is O(file) and optional. */
    contentHash?: string | null;
}
declare class WatermarkTable {
    private readonly ensureStmt;
    private readonly getStmt;
    private readonly advanceStmt;
    private readonly statusStmt;
    private readonly rewindStmt;
    private readonly listStmt;
    constructor(db: Db, { name }?: WatermarkOptions);
    /** The row for a source, created at offset 0 on first sight. The id is stable for the table's life. */
    ensure(sourceKey: string): WatermarkRow;
    get(sourceKey: string): WatermarkRow | undefined;
    /**
     * Record progress on a source `ensure` already created. Returns false, and
     * writes nothing, for a key that was never ensured; a no-op rather than a throw
     * because ingesters may touch keys they have not ensured yet.
     */
    advance(sourceKey: string, update: WatermarkAdvance): boolean;
    /** Back to byte 0, for a source that was rewritten rather than appended to. False for a key never ensured. */
    rewind(sourceKey: string): boolean;
    /** False, and nothing written, for a key never ensured. */
    markStatus(sourceKey: string, status: WatermarkStatus, reason?: string | null): boolean;
    list(): WatermarkRow[];
}

export { type CacheBlobOptions, CacheBlobTable, type CacheHit, type CacheKey, type Db, type EdgeInput, type EdgeRow, EdgeTable, type EdgeTableOptions, type EntityInput, type EntityRow, EntityTable, type KitSelection, MIGRATION_TABLE_NAME, type Migration, MigrationIdentityError, type OpenOptions, type ParsedRef, SQL_NOW, SchemaTooNewError, type SpanFtsOptions, SpanFtsTables, type SpanHit, type SpanInput, type SpanScope, type TableName, type WatermarkAdvance, type WatermarkOptions, type WatermarkRow, type WatermarkStatus, WatermarkTable, appliedVersions, assertSchemaVersion, cacheBlobTableDdl, contentHashOf, edgeTableDdl, entitySnapTableDdl, entityTableDdl, hasColumn, hasTable, isRef, kitDdl, kitMigration, nowIso, openDatabase, parseRef, quoteIdent, ref, refKind, runMigrations, snapshotTableDdl, spanFtsTablesDdl, watermarkTableDdl };

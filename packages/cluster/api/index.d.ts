/** The wildcard token a Drain template uses at a generalized position. */
declare const WILDCARD = "<*>";
/** A single leaf cluster in the Drain tree: one template + its token count. */
interface DrainCluster {
    clusterId: number;
    tokens: string[];
    size: number;
}
/** Result of inserting a tokenized line into a `DrainTree`. */
interface MatchResult {
    cluster: DrainCluster;
    /** True when this insert created a brand-new cluster rather than joining one. */
    isNew: boolean;
    /** True when joining an existing cluster generalized one or more positions. */
    templateChanged: boolean;
    /** Ids of clusters this insert evicted to stay under `maxClusters`; may include `cluster` itself. */
    evicted: number[];
}

/**
 * Token-position similarity between an existing cluster's template tokens
 * and a candidate line's tokens, per the Drain paper (ICWS 2017) / Drain3's
 * `fast_match`. Wildcard positions in `templateTokens` count as matches —
 * they generalize to anything — so a fully-wildcarded template still scores
 * 1.0 against any same-length line.
 *
 * Both arrays must be the same length; callers only ever compare same-length
 * token sequences (Drain partitions by token count before this is called).
 */
declare function tokenSimilarity(templateTokens: string[], lineTokens: string[]): number;
/**
 * Merge a line's tokens into an existing template, generalizing (never
 * tightening) positions that disagree. A position already wildcarded stays
 * wildcarded regardless of what the new line has there.
 */
declare function mergeTemplate(templateTokens: string[], lineTokens: string[]): string[];

interface DrainTreeOptions {
    /**
     * Fixed depth of the prefix tree, matching Drain3's convention: depth
     * includes the root and the token-count branch, so `depth - 2` levels of
     * the tree branch on literal first-tokens before reaching leaf clusters.
     */
    depth?: number;
    /** Minimum token-position similarity (§similarity.ts) to join a cluster. */
    simTh?: number;
    /** Max distinct literal-token children per internal node before overflow collapses to a wildcard branch. */
    maxChildren?: number;
    /**
     * Cap on total clusters in this (single-tool-type) tree. On overflow the
     * *least-supported* cluster is evicted — see `evictIfOverCapacity`.
     *
     * The default is sized from the real corpus (measured on a 710-transcript corpus): 710 transcripts /
     * 23.3k blobs converge on ~2.3k clusters in the busiest partition (`Bash`),
     * so 2000 was below the steady state and the tree evicted continuously over
     * the last ~8% of the corpus. 5000 leaves ~2x headroom while keeping the
     * memory bound the cap exists for (a cluster is one token array; 5000 of
     * them is single-digit MB).
     */
    maxClusters?: number;
}
/**
 * A tree's complete clustering state: every live cluster in LRU order, plus
 * the id counter.
 *
 * The prefix nodes themselves are not stored because they are derivable —
 * `walkToLeaf(cluster.tokens)` re-creates the path a cluster belongs on, the
 * same assumption `evictIfOverCapacity` already relies on to unlink a cluster.
 * What matters is that the clusters come back with their *generalized* tokens
 * and their original ids, which is exactly what re-inserting them through
 * `insert()` cannot guarantee.
 */
interface DrainTreeSnapshot {
    nextClusterId: number;
    /** Access order, oldest first — restoring in order preserves the eviction tie-break. */
    clusters: DrainCluster[];
}
/**
 * A fixed-depth Drain prefix tree (ICWS 2017), partitioned by token count at
 * the root, then by literal first-tokens down to `depth - 2` levels, with
 * leaf nodes holding the clusters matched by token-position similarity.
 *
 * One `DrainTree` instance is one partition (one tool type) — see
 * `registry.ts` for the per-partition registry.
 */
declare class DrainTree {
    private readonly depth;
    private readonly simTh;
    private readonly maxChildren;
    private readonly maxClusters;
    private readonly lengthRoots;
    /** Access order, oldest first: re-inserted on every access, and the tie-break for eviction. */
    private readonly recency;
    private nextClusterId;
    constructor(options?: DrainTreeOptions);
    get clusterCount(): number;
    /**
     * True once the capacity cap is reached, i.e. every further new cluster
     * evicts an existing one. Past this point clustering is no longer a pure
     * function of the blob multiset — a shape whose cluster was evicted and then
     * recurs mints a fresh cluster — so the eval reports it as the bound on what
     * "incremental equals all-at-once" can mean.
     */
    get atCapacity(): boolean;
    /** Capture the tree's clustering state for durable storage. */
    toSnapshot(): DrainTreeSnapshot;
    /**
     * Rebuild a tree from `toSnapshot()` output, re-linking each cluster into
     * its leaf without routing it through `insert()`.
     *
     * Replaying persisted clusters through `insert()` is lossy
     * twice over: two persisted templates similar enough to match would collapse
     * into one cluster, and every restored cluster would get a fresh id, so the
     * `clusterId -> templateId` map could not survive a restart.
     */
    static fromSnapshot(snapshot: DrainTreeSnapshot, options?: DrainTreeOptions): DrainTree;
    /** Insert a tokenized line, returning the cluster it joined or created. */
    insert(tokens: string[]): MatchResult;
    private bestMatch;
    private walkToLeaf;
    private step;
    private touch;
    /**
     * The cluster to drop on overflow: the one with the fewest occurrences, ties
     * broken by least-recently-used.
     *
     * Recency alone (what this did under plain LRU) evicts by arrival order, which
     * is the wrong axis twice over. A recurring shape that happens to be idle —
     * a `tsc` failure seen 200 times, absent for one busy stretch — gets dropped
     * and then re-minted from scratch on its next occurrence, losing its learned
     * wildcards and its `clusterId -> templateId` binding, so the template count
     * climbs instead of settling. And which cluster is idle at the moment of
     * overflow depends on the order blobs arrived in, so two runs over the same
     * blob multiset in different orders diverge.
     *
     * Support is a property of the data rather than of arrival order, so evicting
     * by it keeps the recurring patterns Drain exists to recognize and spends the
     * cap on the one-off long tail (on the real corpus, 1936 of 2408 clusters are
     * singletons). It does not make eviction order-*independent* — nothing does,
     * Drain is an online algorithm — but it bounds the churn to shapes seen once.
     *
     * Iteration is in LRU order and short-circuits on the first singleton, which
     * is the common case, so this is O(1) amortized rather than a full scan.
     */
    private selectVictim;
    /** Returns the evicted cluster's id so the caller can drop anything keyed on it. */
    private evictIfOverCapacity;
}

/**
 * One `DrainTree` per partition key, created lazily. Partition before Drain
 * sees a line (by tool type, log source, whatever the domain routes on) so two
 * sources whose token shapes happen to overlap never share a cluster.
 */
declare class DrainTreeRegistry {
    private readonly options?;
    private readonly trees;
    constructor(options?: DrainTreeOptions | undefined);
    getTree(partition: string): DrainTree;
    /** Install a tree rebuilt from a snapshot, replacing any tree for `partition`. */
    restore(partition: string, snapshot: DrainTreeSnapshot): void;
    snapshot(): Record<string, DrainTreeSnapshot>;
    /** True when any partition has hit its cluster cap and is evicting. */
    get anyAtCapacity(): boolean;
    get partitions(): string[];
}

/**
 * How a partition picks the anchor line of a blob: the first line matching
 * `rules` (tried in rule order) is anchored; otherwise `fallback` picks a
 * positional line, which is unanchored.
 */
interface AnchorConfig {
    rules: readonly RegExp[];
    fallback: 'first-line' | 'last-non-blank';
}
/** Frozen anchor configs keyed by partition; unregistered partitions fall back to `generic`. */
type AnchorConfigs = Readonly<Record<string, AnchorConfig>>;
/**
 * `git` anchors on its first line, `test` tries test-runner shapes (pass/fail
 * counts, `error TS…`, eslint rule ids) before the shell ones, and every other
 * partition uses `generic`: shell diagnostics, then the last non-blank line.
 */
declare const DEFAULT_ANCHOR_CONFIGS: AnchorConfigs;

/**
 * Reduces a multi-line tool-result blob to one deterministic signature line
 * before it reaches Drain, so each blob is clustered by one extracted line.
 * Drain is inherently per-line; stack traces and multi-line summaries break
 * it if fed whole, since line count varies with recursion depth. The
 * signature captures the blob's *shape* — the anchor line that identifies
 * the failure, plus a coarse line-count bucket — without ever touching the
 * full body.
 */

type LineCountBucket = '0' | '1' | '2-5' | '6+';
interface Signature {
    errorClass: string;
    anchorLine: string;
    lineCountBucket: LineCountBucket;
    /**
     * True when `anchorLine` came from a recognized failure-shape rule rather
     * than its partition's positional fallback (last non-blank line, or the first
     * line for a `first-line` partition such as the default `git`). An unanchored
     * signature's clustering key is arbitrary output text, so callers use this to screen successful command output — see
     * `hasErrorSignal`.
     */
    anchored: boolean;
    /** `${errorClass} ${anchorLine} [${lineCountBucket}]` — the string Drain tokenizes. */
    signatureLine: string;
}
/**
 * Reduce a raw tool-result blob to its `Signature` for a given `partition`
 * (the Drain partition key). Never stores or returns the full
 * blob — only the anchor line survives.
 */
declare function extractSignature(partition: string, blobText: string, anchors?: AnchorConfigs): Signature;
/**
 * Whether a blob carries a recognizable failure shape of its own — i.e. whether
 * `extractSignature` would anchor on a matched rule instead of falling back to
 * an arbitrary output line.
 *
 * The clusterer exists to recognize *recurring failures* , and a
 * successful `git log`/`grep`/`cat` has no failure to recognize a repeat of.
 * Clustering it anyway keys on the literal last line of arbitrary stdout, whose
 * cardinality is unbounded — every distinct successful command minted its own
 * permanent singleton cluster, and the template count never flattened.
 */
declare function hasErrorSignal(partition: string, blobText: string, anchors?: AnchorConfigs): boolean;

/**
 * A typed-mask rule: `pattern`/`flags` build a `RegExp`; every match becomes
 * `<name>` in the masked signature, and the first match's text is recorded
 * under `extractedParams[name]`.
 */
interface MaskRule {
    name: string;
    pattern: string;
    flags: string;
}
interface MaskResult {
    maskedSignature: string;
    extractedParams: Record<string, string>;
}
/** Frozen mask configs keyed by partition; unregistered partitions fall back to `generic`. */
type MaskConfigs = Record<string, MaskRule[]>;
declare const DEFAULT_MASK_CONFIGS: MaskConfigs;
/**
 * Apply the partition's mask rules to a signature line in rule order, so an
 * earlier rule's placeholder (`<UUID>`) is never re-matched by a later, looser
 * rule (`<NUM>`).
 */
declare function applyMasks(partition: string, signatureLine: string, configs?: MaskConfigs): MaskResult;

/**
 * Template ID: a content-hash of `(partition, maskedSignature)`. `Clusterer`
 * hashes only the line that founds a Drain cluster and binds the result to the
 * cluster, so lines Drain merges later share the founder's ID. IDs are therefore
 * deterministic for a given input order, not independent of it.
 */
declare function templateId(partition: string, maskedSignature: string): string;

interface ClustererOptions {
    drain?: DrainTreeOptions;
    masks?: MaskConfigs;
    anchors?: AnchorConfigs;
}
interface ClusterInput {
    /** Drain partition, e.g. a tool type. Also selects the mask config. */
    partition: string;
    text: string;
}
interface ClusterResult {
    templateId: string;
    partition: string;
    maskedSignature: string;
    extractedParams: Record<string, string>;
    signature: Signature;
    /**
     * True when no live cluster was bound to this template id before this call.
     * A template whose cluster was evicted and later recurs is new again, as it
     * already was across a snapshot restore; callers that need lifetime novelty
     * check their own template store.
     */
    isNewTemplate: boolean;
}
/** One partition's persisted state: the Drain tree plus its cluster-to-template bindings. */
interface PartitionSnapshot extends DrainTreeSnapshot {
    partition: string;
    templateIds: [clusterId: number, templateId: string][];
}
interface ClustererSnapshot {
    version: 1;
    partitions: PartitionSnapshot[];
}
/**
 * Narrow a stored value to a snapshot, or throw. Template ids are founder-order,
 * so a caller must not answer this throw with a fresh `Clusterer`: that rebinds them.
 */
declare function parseClustererSnapshot(value: unknown): ClustererSnapshot;
/**
 * The storage-free clustering pipeline: signature extraction, masking, Drain,
 * founder-order template id. Persist the snapshot to survive restarts with
 * learned wildcards and id bindings intact; where occurrences go is the
 * caller's concern.
 */
declare class Clusterer {
    private readonly registry;
    private readonly masks;
    private readonly anchors;
    private readonly clusterTemplateIds;
    /** Live bindings per template id; several clusters can share one id. */
    private readonly boundTemplateIds;
    constructor(options?: ClustererOptions);
    static fromSnapshot(snapshot: ClustererSnapshot, options?: ClustererOptions): Clusterer;
    cluster({ partition, text }: ClusterInput): ClusterResult;
    snapshot(): ClustererSnapshot;
    get templateCount(): number;
    /** True once any partition is at its cluster cap; clustering is no longer order-independent. */
    get evicting(): boolean;
    private bind;
    private unbind;
}

export { type AnchorConfig, type AnchorConfigs, type ClusterInput, type ClusterResult, Clusterer, type ClustererOptions, type ClustererSnapshot, DEFAULT_ANCHOR_CONFIGS, DEFAULT_MASK_CONFIGS, type DrainCluster, DrainTree, type DrainTreeOptions, DrainTreeRegistry, type DrainTreeSnapshot, type LineCountBucket, type MaskConfigs, type MaskResult, type MaskRule, type MatchResult, type PartitionSnapshot, type Signature, WILDCARD, applyMasks, extractSignature, hasErrorSignal, mergeTemplate, parseClustererSnapshot, templateId, tokenSimilarity };

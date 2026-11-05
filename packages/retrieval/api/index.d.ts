import { SpanScope, SpanFtsTables, EdgeTable } from '@titan-design/store-sqlite';
import { Embedder } from '@titan-design/embed';

/** One candidate from one retriever. Lower `rank` is better; `score` is retriever-specific and optional. */
interface Hit {
    id: string;
    rank: number;
    score?: number;
    /** Anything the retriever wants to hand downstream (a locator, a distance, a hop count). */
    payload?: Record<string, unknown>;
}
interface RetrieveOptions {
    limit: number;
    signal?: AbortSignal;
}
/** A source of ranked candidates: FTS, vectors, graph expansion, a custom SQL query. */
interface Retriever {
    readonly name: string;
    retrieve(query: string, options: RetrieveOptions): Promise<Hit[]>;
}
interface FusedResult {
    id: string;
    score: number;
    /** Which retrievers contributed, so callers can explain a result. */
    sources: string[];
    /** Merged payloads, keyed by retriever name. */
    payloads: Record<string, Record<string, unknown>>;
}

interface RankedList {
    name: string;
    hits: Hit[];
}
interface RrfOptions {
    /** Reciprocal-rank constant; 60 is the literature default and what brain shipped. */
    k?: number;
    /** Per-retriever weight; unlisted retrievers weigh 1. */
    weights?: Record<string, number>;
}
/**
 * Reciprocal rank fusion: each list contributes `weight / (k + rank)` for every
 * id it ranks, so an id present in several lists rises above one that is top
 * of a single list. Rank-based, so retrievers with incomparable scores fuse
 * cleanly. Stable: ties keep first-seen order.
 */
declare function fuseByRRF(lists: RankedList[], options?: RrfOptions): FusedResult[];
/**
 * Cut at the largest relative score drop between neighbours, when that drop is
 * at least `threshold` (0.15 = a 15% fall). Always keeps the first result.
 */
declare function applyDropoff<T extends {
    score: number;
}>(results: T[], threshold: number): T[];

interface Degradation {
    retriever: string;
    reason: "error" | "timeout";
    message: string;
}
interface GatheredLists {
    lists: RankedList[];
    degraded: Degradation[];
    timingsMs: Record<string, number>;
}
interface GatherOptions extends RetrieveOptions {
    /** Per-retriever deadline. A slow retriever degrades the answer; it never blocks it. */
    timeoutMs?: number;
}
/**
 * Run every retriever concurrently and keep going when one fails or stalls.
 * A failed retriever contributes an empty list and a `degraded` entry, so a
 * missing embedder or a locked index reduces recall instead of breaking search.
 */
declare function gatherFailOpen(retrievers: Retriever[], query: string, options: GatherOptions): Promise<GatheredLists>;

interface FtsRetrieverOptions {
    name?: string;
    /** Turn a free-text query into an FTS5 MATCH expression. The default quotes each word and ORs them. */
    toMatchExpression?: (query: string) => string;
    /**
     * Restrict this retriever to one class of owner, so it becomes one ranked
     * list among several rather than the whole index.
     *
     * Register one scoped retriever per class and let RRF fuse them. Rank is
     * computed within a list, so a class of 92,713 spans cannot swamp a class of
     * 1,569: it only ever contributes its own top-N. One pooled retriever over
     * the same tables returns the large class and nothing else.
     */
    scope?: SpanScope;
    /**
     * Hard ceiling on hits from this retriever, whatever the engine asks for.
     *
     * The engine's overfetch is uniform across retrievers, which is the wrong
     * shape for a class prior: some classes are duplicate content of others and
     * should contribute a handful of candidates at most. A cap says that in one
     * number, and it composes with `fusion.weights` rather than replacing it —
     * the weight sets how much a hit counts, the cap sets how many there are.
     */
    cap?: number;
}
/** Quote tokens so punctuation in user text cannot break FTS5 syntax; OR them for recall. */
declare function defaultMatchExpression(query: string): string;
/**
 * BM25 over a contentless span index. Several spans of one owner collapse to
 * the owner's best rank, and the winning span's locator rides along as payload.
 */
declare function ftsRetriever(spans: Pick<SpanFtsTables, "search">, options?: FtsRetrieverOptions): Retriever;

interface VectorMatch {
    id: string;
    similarity: number;
}
/** Nearest-neighbour lookup. Implement over sqlite-vec, a brute-force scan, or a remote index. */
interface VectorIndex {
    search(vector: number[], limit: number): Promise<VectorMatch[]>;
}
/**
 * Exact cosine search over vectors held in memory. Fine to tens of thousands of
 * rows; past that, back it with sqlite-vec behind the same interface.
 */
declare class BruteForceVectorIndex implements VectorIndex {
    private readonly rows;
    add(id: string, vector: number[]): void;
    remove(id: string): void;
    get size(): number;
    search(vector: number[], limit: number): Promise<VectorMatch[]>;
}
interface VectorRetrieverOptions {
    name?: string;
    /** Drop matches below this cosine similarity. */
    minSimilarity?: number;
}
declare function vectorRetriever(embedder: Embedder, index: VectorIndex, options?: VectorRetrieverOptions): Retriever;

interface GraphRetrieverOptions {
    name?: string;
    /** Only follow these relations; all when omitted. */
    relations?: string[];
    /** How far to walk from the seeds. */
    hops?: number;
    /** Follow edges in both directions (default) or only source to target. */
    direction?: "both" | "out";
    /**
     * A non-seed node with at least this many followed edges is returned but not expanded. Uncapped
     * when omitted: the edge table cannot list every node's degree, so pass
     * `defaultHubDegree(degrees)` from your own counts to get the walk's p99 default.
     */
    hubDegree?: number;
    /** Stop once this many neighbours have been reached (default unlimited). */
    maxNodes?: number;
}
/**
 * Expand a set of seed ids through the edge table, ranking neighbours by hop
 * distance then discovery order. Wrap it with `seededBy` so the seeds come
 * from another retriever's top results for the same query.
 */
declare function expandGraph(edges: EdgeTable, seeds: string[], options?: GraphRetrieverOptions): Hit[];
/** A graph retriever whose seeds are the top results of another retriever for the same query. */
declare function graphRetriever(edges: EdgeTable, seededBy: Retriever, options?: GraphRetrieverOptions & {
    seedLimit?: number;
}): Retriever;

/*!
 * The hub cap (a non-seed node of degree >= max(50, p99 degree) is returned but never
 * expanded) is adapted from graphify, https://github.com/Graphify-Labs/graphify,
 * graphify/serve.py (_bfs, _dfs). Copyright 2026 Safi Shamsi and the Graphify contributors,
 * licensed under the Apache License 2.0, http://www.apache.org/licenses/LICENSE-2.0.
 * Changed here: the walk runs over any adjacency through a neighbours/degree pair instead of a
 * networkx graph, keeps the discovery order and the edge each node was reached by, and stops
 * at an optional node limit.
 * @license Apache-2.0
 */
interface WalkNeighbour {
    id: string;
    relation: string;
}
/** The adjacency a walk needs. `degrees` lists every node's degree so the default hub cap can take the p99. */
interface WalkGraph {
    neighbours(id: string): WalkNeighbour[];
    degree(id: string): number;
    degrees?(): Iterable<number>;
}
interface WalkOptions {
    /** How far to walk from the seeds (default 1). */
    hops?: number;
    /** A non-seed node at or above this degree is returned but not expanded. Default `defaultHubDegree(graph.degrees())`. */
    hubDegree?: number;
    /** Stop once this many nodes have been reached (default unlimited). */
    maxNodes?: number;
}
/** One reached node: the hop it was found at and the node and relation it was reached through. */
interface WalkStep {
    id: string;
    hop: number;
    via: string;
    relation: string;
}
/** max(50, p99 degree): the floor keeps a small graph from treating its busiest node as a hub. */
declare function defaultHubDegree(degrees: Iterable<number>): number;
/**
 * Breadth-first walk from the seeds, in hop then discovery order. A hub stays in the output,
 * but its neighbours are only reached through it when it is a seed, so one busy node cannot
 * flood the result with everything it touches.
 */
declare function walkGraph(graph: WalkGraph, seeds: string[], options?: WalkOptions): WalkStep[];

/** Scores query/candidate pairs; higher is more relevant. Cross-encoders live here. */
interface Reranker {
    readonly model: string;
    score(query: string, texts: string[]): Promise<number[]>;
}
interface Candidate {
    id: string;
    text: string;
}
interface Reranked extends Candidate {
    rerankScore: number;
}
/** Score every candidate and sort descending. Skipped for fewer than two candidates. */
declare function rerankCandidates(reranker: Reranker, query: string, candidates: Candidate[]): Promise<Reranked[]>;
type Classifier = (pairs: [string, string][], options: {
    top_k: number;
}) => Promise<{
    label: string;
    score: number;
}[]>;
interface CrossEncoderOptions {
    model?: string;
    /** The cross-encoder's context window is ~512 tokens; longer texts are cut. */
    maxChars?: number;
    /** Injectable for tests; defaults to `@huggingface/transformers` (optional peer). */
    loadClassifier?: (model: string) => Promise<Classifier>;
}
/** In-process cross-encoder (default `Xenova/ms-marco-MiniLM-L-6-v2`), loaded on first use. */
declare function crossEncoderReranker(options?: CrossEncoderOptions): Reranker;

interface EngineOptions {
    retrievers: Retriever[];
    fusion?: RrfOptions;
    /** Fetch this many times `limit` from each retriever before fusing; 3 mirrors brain. */
    overfetch?: number;
    /** Per-retriever deadline for fail-open gathering. */
    timeoutMs?: number;
    /** Drop fused results below this score. */
    minScore?: number;
    /** Cut at the largest relative score drop of at least this fraction. */
    dropoff?: number;
    reranker?: Reranker;
    /** Text for the reranker to read per result; required when a reranker is set. */
    textFor?: (result: FusedResult) => Promise<string> | string;
}
interface SearchOptions {
    limit?: number;
    signal?: AbortSignal;
    /** Skip the reranker for this query. */
    rerank?: boolean;
}
interface SearchResponse {
    results: FusedResult[];
    degraded: Degradation[];
    timingsMs: Record<string, number>;
}
interface RetrievalEngine {
    search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}
/** Retrievers in parallel (fail-open), RRF fusion, score filters, optional cross-encoder rerank. */
declare function createRetrievalEngine(options: EngineOptions): RetrievalEngine;
/** What a failed rerank reports itself as in `degraded`, alongside the retrievers' own entries. */
declare const RERANK_STAGE = "rerank";

export { BruteForceVectorIndex, type Candidate, type CrossEncoderOptions, type Degradation, type EngineOptions, type FtsRetrieverOptions, type FusedResult, type GatherOptions, type GatheredLists, type GraphRetrieverOptions, type Hit, RERANK_STAGE, type RankedList, type Reranked, type Reranker, type RetrievalEngine, type RetrieveOptions, type Retriever, type RrfOptions, type SearchOptions, type SearchResponse, type VectorIndex, type VectorMatch, type VectorRetrieverOptions, type WalkGraph, type WalkNeighbour, type WalkOptions, type WalkStep, applyDropoff, createRetrievalEngine, crossEncoderReranker, defaultHubDegree, defaultMatchExpression, expandGraph, ftsRetriever, fuseByRRF, gatherFailOpen, graphRetriever, rerankCandidates, vectorRetriever, walkGraph };

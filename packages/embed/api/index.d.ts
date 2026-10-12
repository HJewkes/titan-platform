/** What a text is for. Models trained with task prefixes embed a document and a query differently. */
type EmbedRole = "document" | "query";
interface EmbedOptions {
    /** Defaults to `document`. The embedder, not the caller, turns the role into model-specific text. */
    role?: EmbedRole;
}
interface Embedder {
    /**
     * Identifies the vector space: the model plus any per-role prefixes it
     * applies. Cache and index keys must include it; vectors from different
     * spaces never mix.
     */
    readonly model: string;
    /** The backend's own model name, when it differs from `model`. */
    readonly modelName?: string;
    readonly dimensions: number;
    embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;
    dispose?(): Promise<void>;
}

/** The text an embedder prepends for each role. Models trained with task prefixes expect exactly one per text. */
type RolePrefixes = Readonly<Record<EmbedRole, string>>;
declare const NO_PREFIXES: RolePrefixes;
/** nomic-embed-text's retrieval task prefixes. */
declare const NOMIC_PREFIXES: RolePrefixes;
/** The prefixes a model is trained with; none unless it is a nomic model. */
declare function defaultPrefixesFor(modelName: string): RolePrefixes;
/**
 * The vector-space identity of a model under a prefix table, e.g.
 * `nomic-embed-text#p=1a2b3c4d`. Always suffixed, even for an empty table,
 * because a bare model name was the pre-0.2 key and could hold vectors made
 * under any prefix.
 */
declare function vectorSpaceId(modelName: string, prefixes: RolePrefixes): string;

interface HashEmbedderOptions {
    dimensions?: number;
}
/**
 * Zero-download fallback: feature hashing of word unigrams and bigrams into a
 * fixed-width bag, sign-hashed to spread collisions, L2-normalized. Not a
 * semantic model; it captures lexical overlap so pipelines keep working, and
 * degrades gracefully, when no real embedder is reachable. Deterministic across
 * processes and machines.
 */
declare class HashEmbedder implements Embedder {
    readonly model: string;
    readonly dimensions: number;
    constructor({ dimensions }?: HashEmbedderOptions);
    /** Lexical, so a role changes nothing: documents and queries share one space with no prefixes. */
    embed(texts: string[], _options?: EmbedOptions): Promise<number[][]>;
    private embedOne;
}

interface OllamaEmbedderOptions {
    /** Ollama base URL; local by default. A remote Ollama is the same thing with a different host. */
    url?: string;
    model?: string;
    dimensions?: number;
    /** Per-role prefixes; each role left out takes the model's default (nomic's task prefixes, else none). */
    prefixes?: Partial<RolePrefixes>;
    timeoutMs?: number;
    /** Injectable for tests; defaults to global fetch. */
    fetch?: typeof fetch;
}
/** Talks to Ollama's `/api/embed` over plain HTTP, so there is no SDK to depend on. */
declare class OllamaEmbedder implements Embedder {
    readonly model: string;
    readonly modelName: string;
    readonly dimensions: number;
    readonly prefixes: RolePrefixes;
    private readonly baseUrl;
    private readonly timeoutMs;
    private readonly fetchImpl;
    constructor(options?: OllamaEmbedderOptions);
    embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;
    private post;
}

interface LocalEmbedderOptions {
    /** A Hugging Face model id with ONNX weights, e.g. `Xenova/bge-small-en-v1.5`. */
    model?: string;
    dimensions?: number;
    dtype?: "fp32" | "fp16" | "q8" | "q4";
    /** Per-role prefixes; none by default except for nomic models. bge v1.5 takes an optional query instruction here. */
    prefixes?: Partial<RolePrefixes>;
    /** Injectable for tests; defaults to importing `@huggingface/transformers`. */
    loadPipeline?: () => Promise<PipelineFactory>;
}
/** The slice of `@huggingface/transformers` this class uses, so the package can stay an optional peer. */
interface FeatureExtractor {
    (texts: string[], options: {
        pooling: "mean";
        normalize: boolean;
    }): Promise<{
        tolist(): number[][];
    }>;
    dispose(): Promise<void>;
}
type PipelineFactory = (task: "feature-extraction", model: string, options: {
    dtype: string;
}) => Promise<FeatureExtractor>;
/** In-process ONNX embeddings. Downloads the model on first use; weights are cached by the runtime. */
declare class LocalEmbedder implements Embedder {
    readonly model: string;
    readonly modelName: string;
    readonly dimensions: number;
    readonly prefixes: RolePrefixes;
    private readonly dtype;
    private readonly loadPipeline;
    private extractor;
    constructor(options?: LocalEmbedderOptions);
    embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;
    dispose(): Promise<void>;
}

type EmbedderConfig = ({
    backend: "hash";
} & HashEmbedderOptions) | ({
    backend: "ollama";
} & OllamaEmbedderOptions) | ({
    backend: "local";
} & LocalEmbedderOptions);
interface CreateEmbedderOptions {
    /**
     * Probe the backend once at creation and fall back to the hash embedder if
     * it fails. A startup decision, not a per-call one: the returned embedder's
     * `model` says which space you got, and vectors from two spaces never mix.
     */
    fallbackToHash?: boolean;
    onFallback?: (reason: Error) => void;
}
declare function instantiateEmbedder(config: EmbedderConfig): Embedder;
declare function createEmbedder(config: EmbedderConfig, options?: CreateEmbedderOptions): Promise<Embedder>;

declare function dot(a: readonly number[], b: readonly number[]): number;
declare function norm(v: readonly number[]): number;
/** Unit-length copy; the zero vector stays zero. */
declare function normalize(v: readonly number[]): number[];
declare function cosineSimilarity(a: readonly number[], b: readonly number[]): number;
/** Little-endian float32 bytes, the shape a cache_blob or sqlite-vec column stores. */
declare function toFloat32Buffer(v: readonly number[]): Buffer;
declare function fromFloat32Buffer(buffer: Buffer): number[];

export { type CreateEmbedderOptions, type EmbedOptions, type EmbedRole, type Embedder, type EmbedderConfig, type FeatureExtractor, HashEmbedder, type HashEmbedderOptions, LocalEmbedder, type LocalEmbedderOptions, NOMIC_PREFIXES, NO_PREFIXES, OllamaEmbedder, type OllamaEmbedderOptions, type PipelineFactory, type RolePrefixes, cosineSimilarity, createEmbedder, defaultPrefixesFor, dot, fromFloat32Buffer, instantiateEmbedder, norm, normalize, toFloat32Buffer, vectorSpaceId };

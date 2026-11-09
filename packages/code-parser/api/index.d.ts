import { Tree, Node } from 'web-tree-sitter';

interface ParsedFile {
    tree: Tree;
    content: string;
    filePath: string;
    language: string;
}
interface Extractor<T> {
    name: string;
    extract(file: ParsedFile): T[];
}

type FilterLanguage = "typescript" | "python";
/**
 * True when a directory NAME should be pruned from a recursive source walk
 * (node_modules, dist, .git, …). File discovery already rejects files under
 * these via `shouldIncludeFile`, but a walker that recurses into them anyway
 * pays to `readdir` the entire tree (e.g. a multi-GB `node_modules`) only to
 * discard every file — so pruning at the directory level is a large speedup and
 * changes no output. Kept in sync with `EXCLUDED_DIRS`.
 */
declare function isExcludedDir(dirName: string): boolean;
declare function shouldIncludeFile(filePath: string, languages: FilterLanguage[]): boolean;
declare function getLanguageFromPath(filePath: string): FilterLanguage | null;

type GrammarLanguage = FilterLanguage | "tsx";
declare function parseFile(content: string, filePath: string, language: GrammarLanguage): Promise<ParsedFile>;
declare function getSupportedLanguages(): GrammarLanguage[];

/**
 * The tree-sitter node types and walkers behind cyclomatic complexity and nesting depth, kept in
 * one place so code-graph's source metrics and style-analyzer's complexity extractor count alike.
 */
/** TypeScript statements that open a nesting level. */
declare const TS_NESTING_TYPES: ReadonlySet<string>;
/** Python statements that open a nesting level. */
declare const PY_NESTING_TYPES: ReadonlySet<string>;
/** TypeScript nodes that each add one decision path. */
declare const TS_BRANCH_TYPES: ReadonlySet<string>;
/** Python nodes that each add one decision path. */
declare const PY_BRANCH_TYPES: ReadonlySet<string>;
interface NestingOptions {
    /** Keep an `else if` chain at its `if`'s depth, as ESLint max-depth and Sonar do. */
    readonly flattenElseIf?: boolean;
}
/** McCabe cyclomatic complexity of `body`: one plus every branch node and boolean operator under it. */
declare function cyclomaticOf(body: Node, language: string): number;
/** Deepest nesting level under `node`, starting from `depth`. */
declare function nestingDepthOf(node: Node, language: string, depth?: number, options?: NestingOptions): number;

export { type Extractor, type FilterLanguage, type GrammarLanguage, type NestingOptions, PY_BRANCH_TYPES, PY_NESTING_TYPES, type ParsedFile, TS_BRANCH_TYPES, TS_NESTING_TYPES, cyclomaticOf, getLanguageFromPath, getSupportedLanguages, isExcludedDir, nestingDepthOf, parseFile, shouldIncludeFile };

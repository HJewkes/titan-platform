import { Tree } from 'web-tree-sitter';

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

declare function parseFile(content: string, filePath: string, language: string): Promise<ParsedFile>;
declare function getSupportedLanguages(): string[];

/**
 * True when a directory NAME should be pruned from a recursive source walk
 * (node_modules, dist, .git, …). File discovery already rejects files under
 * these via `shouldIncludeFile`, but a walker that recurses into them anyway
 * pays to `readdir` the entire tree (e.g. a multi-GB `node_modules`) only to
 * discard every file — so pruning at the directory level is a large speedup and
 * changes no output. Kept in sync with `EXCLUDED_DIRS`.
 */
declare function isExcludedDir(dirName: string): boolean;
declare function shouldIncludeFile(filePath: string, languages: string[]): boolean;
declare function getLanguageFromPath(filePath: string): string | null;

export { type Extractor, type ParsedFile, getLanguageFromPath, getSupportedLanguages, isExcludedDir, parseFile, shouldIncludeFile };

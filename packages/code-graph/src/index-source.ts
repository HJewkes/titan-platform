import { existsSync, readFileSync } from "node:fs";
import { Project, type FileSystemHost } from "ts-morph";
import { walkSourceFiles } from "./file-walk.js";

/**
 * Where the indexer reads a tree from. Every path is absolute and node ids are
 * derived from it, so a source that is not the working tree (a git commit, say)
 * keeps ids byte-identical by answering for the same absolute paths.
 */
export interface IndexSource {
  /** Source files under `rootDirs` that pass the ingest filter for `languages`, deduped, in walk order. */
  listFiles(rootDirs: readonly string[], languages: readonly string[]): Promise<string[]>;
  /** UTF-8 content of a file; throws when it does not exist. */
  readFile(abs: string): string;
  fileExists(abs: string): boolean;
  /** The host ts-morph resolves imports and reads tsconfig through. */
  readonly fileSystem: FileSystemHost;
  /** Set when the source is a git commit rather than the working tree; undefined for the working tree. */
  readonly revision?: {
    /** The repo's toplevel, canonicalized with realpath. */
    readonly repoRoot: string;
    readonly commit: string;
    /** Committer time, seconds since the epoch. */
    readonly commitEpoch: number;
  };
}

let realFileSystem: FileSystemHost | undefined;

/** ts-morph exports no RealFileSystemHost, but a bare Project builds one and hands it back. */
function realFileSystemHost(): FileSystemHost {
  realFileSystem ??= new Project().getFileSystem();
  return realFileSystem;
}

/** The checked-out working tree, read through `node:fs`. The default source. */
export function workingTreeSource(): IndexSource {
  return {
    listFiles: walkSourceFiles,
    readFile: (abs) => readFileSync(abs, "utf-8"),
    fileExists: existsSync,
    get fileSystem() {
      return realFileSystemHost();
    },
  };
}

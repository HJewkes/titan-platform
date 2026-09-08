import type { Tree } from "web-tree-sitter";

export interface ParsedFile {
  tree: Tree;
  content: string;
  filePath: string;
  language: string;
}

export interface Extractor<T> {
  name: string;
  extract(file: ParsedFile): T[];
}

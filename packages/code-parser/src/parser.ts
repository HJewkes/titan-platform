import { Parser, Language } from "web-tree-sitter";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { FilterLanguage } from "./file-filter.js";
import type { ParsedFile } from "./types.js";

export type GrammarLanguage = FilterLanguage | "tsx";

const require = createRequire(import.meta.url);

let initialized = false;
const parsers = new Map<string, Parser>();
const languages = new Map<string, Language>();

function resolveWasmPath(language: GrammarLanguage): string {
  switch (language) {
    case "typescript":
      return require.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm");
    case "tsx":
      return require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm");
    case "python":
      return require.resolve("tree-sitter-python/tree-sitter-python.wasm");
    default:
      throw new Error(`Unsupported language: ${String(language)}`);
  }
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

async function getLanguage(language: GrammarLanguage): Promise<Language> {
  const cached = languages.get(language);
  if (cached) return cached;

  const wasmPath = resolveWasmPath(language);
  const lang = await Language.load(wasmPath);
  languages.set(language, lang);
  return lang;
}

async function getParser(language: GrammarLanguage): Promise<Parser> {
  const cached = parsers.get(language);
  if (cached) return cached;

  // Validate language before initializing WASM
  resolveWasmPath(language);

  await ensureInitialized();
  const lang = await getLanguage(language);
  const parser = new Parser();
  parser.setLanguage(lang);
  parsers.set(language, parser);
  return parser;
}

// The filter's `typescript` covers `.tsx`, but only the tsx grammar parses JSX.
function grammarFor(language: GrammarLanguage, filePath: string): GrammarLanguage {
  return language === "typescript" && path.extname(filePath) === ".tsx" ? "tsx" : language;
}

export async function parseFile(
  content: string,
  filePath: string,
  language: GrammarLanguage,
): Promise<ParsedFile> {
  const parser = await getParser(grammarFor(language, filePath));
  const tree = parser.parse(content);
  if (!tree) {
    throw new Error(`Failed to parse ${filePath}`);
  }
  return { tree, content, filePath, language };
}

export function getSupportedLanguages(): GrammarLanguage[] {
  return ["typescript", "tsx", "python"];
}

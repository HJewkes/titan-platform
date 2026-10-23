import { isBuiltin } from "node:module";

/** Reads a repo-relative file at head; null when no regular file is there. */
export type ReadAtHead = (path: string) => Promise<string | null>;

// Bounds the git reads one changed test can cost the judge; a larger closure is read as leaving carry.
const MAX_FILES = 200;
// A statement importing or re-exporting only types is erased before the test runs, so it loads nothing a mutation could change.
const TYPE_ONLY_STATEMENT = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\*|\w+)\s+from\s*["'][^"']*["']/g;
const LITERAL_SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const COMPUTED_LOAD = /\b(?:import|require)\s*\(\s*(?!["'][^"']*["']\s*\))/;
const TS_FOR_JS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"], ".jsx": [".tsx"] };
const BARE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];

/** Every module specifier the file loads at runtime, or null when it loads one it computes. */
export function runtimeSpecifiers(text: string): string[] | null {
  const loaded = text.replace(TYPE_ONLY_STATEMENT, "");
  if (COMPUTED_LOAD.test(loaded)) return null;
  return [...loaded.matchAll(LITERAL_SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function isRunnerOrBuiltin(specifier: string): boolean {
  return specifier === "vitest" || specifier.startsWith("vitest/") || specifier.startsWith("node:") || isBuiltin(specifier);
}

function joinRelative(from: string, specifier: string): string | null {
  const segments = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  return segments.length > 0 ? segments.join("/") : null;
}

function candidatesFor(path: string): string[] {
  const extension = Object.keys(TS_FOR_JS).find((ext) => path.endsWith(ext));
  if (extension === undefined) return [path, ...BARE_EXTENSIONS.map((suffix) => path + suffix)];
  return [...TS_FOR_JS[extension]!.map((ts) => path.slice(0, -extension.length) + ts), path];
}

async function resolveRelative(from: string, specifier: string, read: ReadAtHead): Promise<{ path: string; text: string } | null> {
  const joined = joinRelative(from, specifier);
  if (joined === null) return null;
  for (const path of candidatesFor(joined)) {
    const text = await read(path);
    if (text !== null) return { path, text };
  }
  return null;
}

/**
 * True when everything a carried test loads at runtime, followed through every carried file it reaches, is carried, a
 * Node builtin or vitest. No mutation may target a carried file, so only such a test is one no spec could ever cover.
 * A bare package, a relative import that resolves to no file or outside carry, or a computed load reads as false.
 */
export async function loadsOnlyCarried(test: string, read: ReadAtHead, isCarried: (path: string) => boolean): Promise<boolean> {
  const first = await read(test);
  if (first === null || !isCarried(test)) return false;
  const queue = [{ path: test, text: first }];
  const seen = new Set([test]);
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const specifiers = runtimeSpecifiers(file.text);
    if (specifiers === null) return false;
    for (const specifier of specifiers.filter((spec) => !isRunnerOrBuiltin(spec))) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
      const resolved = await resolveRelative(file.path, specifier, read);
      if (resolved === null || !isCarried(resolved.path)) return false;
      if (seen.has(resolved.path)) continue;
      if (seen.add(resolved.path).size > MAX_FILES) return false;
      queue.push(resolved);
    }
  }
  return true;
}

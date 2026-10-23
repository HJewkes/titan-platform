/** Reads a repo-relative file at head; null when no regular file is there. */
type ReadAtHead = (path: string) => Promise<string | null>;

// Bounds the git reads one changed test can cost the judge; a larger closure is read as leaving carry.
const MAX_FILES = 200;
// A statement importing or re-exporting only types is erased before the test runs, so it loads nothing a mutation could change.
const TYPE_ONLY_STATEMENT = /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\*|\w+)\s+from\s*["'][^"']*["']/g;
const LITERAL_SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
// Ways to run code that no static import names: a computed load, evaluated source, vitest's own loaders, a native addon.
const LOAD_OUTSIDE_GRAPH =
  /\b(?:import|require)\s*\(\s*(?!["'][^"']*["']\s*\))|\beval\s*\(|\bFunction\s*\(|\bimport(?:Actual|Mock)\b|\bprocess\s*\.\s*(?:dlopen|binding)\b/;
/**
 * The only modules a closure may load from outside carry: vitest itself, and builtins that cannot start a process, a
 * worker or evaluated source. Anything unlisted (child_process, worker_threads, cluster, vm, module, inspector) could run
 * a file a mutation may target, so it leaves carry.
 */
const SAFE_BUILTINS = [
  ...["assert", "assert/strict", "buffer", "crypto", "events", "fs", "fs/promises", "os", "path", "path/posix"],
  ...["stream", "stream/promises", "string_decoder", "timers", "timers/promises", "url", "util", "util/types", "zlib"],
];
const SAFE_OUTSIDE_CARRY = new Set(["vitest", ...SAFE_BUILTINS, ...SAFE_BUILTINS.map((name) => `node:${name}`)]);
const TS_FOR_JS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"], ".jsx": [".tsx"] };
const BARE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];

/** Every module specifier the file loads at runtime, or null when it may run code no literal specifier names. */
export function runtimeSpecifiers(text: string): string[] | null {
  const loaded = text.replace(TYPE_ONLY_STATEMENT, "");
  if (LOAD_OUTSIDE_GRAPH.test(loaded)) return null;
  return [...loaded.matchAll(LITERAL_SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
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
 * True when everything a carried test loads at runtime, followed through every carried file it reaches, is carried,
 * vitest or a builtin in `SAFE_OUTSIDE_CARRY`. No mutation may target a carried file, so such a test needs no spec.
 * A bare package, a relative import that resolves to no file or outside carry, a process, worker or vm builtin, or code
 * run outside the import graph (a computed load, eval, `vi.importActual`) reads as false.
 * Assumes the closure reads files through `fs` only to judge tests or carried files, which no mutation may target either:
 * a carried test that asserts on the text of non-carried source it reads is exempt here, yet a spec could cover it.
 */
export async function loadsOnlyCarried(test: string, read: ReadAtHead, isCarried: (path: string) => boolean): Promise<boolean> {
  const first = await read(test);
  if (first === null || !isCarried(test)) return false;
  const queue = [{ path: test, text: first }];
  const seen = new Set([test]);
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const specifiers = runtimeSpecifiers(file.text);
    if (specifiers === null) return false;
    for (const specifier of specifiers.filter((spec) => !SAFE_OUTSIDE_CARRY.has(spec))) {
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

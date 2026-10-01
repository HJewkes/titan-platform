import type { WordToken } from "./lexer.js";

/** POSIX `path.resolve` for an already absolute base, without Node built-ins. */
export function resolveFrom(base: string, relative: string): string {
  const parts: string[] = [];
  const joined = relative.startsWith("/") ? relative : `${base}/${relative}`;
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Absolute path a word names from `dir`, or null when the word is dynamic or the base is unknown. */
export function resolvePath(dir: string | null, word: WordToken | null | undefined, home: string | null): string | null {
  if (!word || word.dynamic) return null;
  const v = word.value;
  if (v === "~" || v.startsWith("~/")) return home === null ? null : resolveFrom(home, v.slice(2));
  if (v.startsWith("/")) return resolveFrom("/", v);
  return dir === null ? null : resolveFrom(dir, v);
}

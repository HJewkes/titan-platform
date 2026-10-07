import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Where an active-work workspace keeps things, owned in one place so every
 * reader agrees on it.
 *
 * A retired initiative moves to `archive/<slug>` with its layout intact. A
 * loader that sees the archive and a ref rule that does not would mint refs no
 * label can ever match, so lookups, path-to-ref and ref-to-path all live here.
 */

const ARCHIVE = "archive";

/** Path segments under an initiative dir. `legacyNotes` predates the move to `sources/notes`. */
export const LAYOUT = {
  notes: ["sources", "notes"],
  legacyNotes: ["notes"],
  sources: ["sources"],
  sessions: ["sessions"],
} as const;

export interface InitiativeDir {
  slug: string;
  dir: string;
}

/** Every live initiative, then every archived one, since a retired initiative is still real data. */
export function initiativeDirs(activeRoot: string): InitiativeDir[] {
  const archive = path.join(activeRoot, ARCHIVE);
  const live = subdirs(activeRoot).filter((slug) => slug !== ARCHIVE);
  const archived = existsSync(archive) ? subdirs(archive) : [];
  return [
    ...live.map((slug) => ({ slug, dir: path.join(activeRoot, slug) })),
    ...archived.map((slug) => ({ slug, dir: path.join(archive, slug) })),
  ];
}

function subdirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

/** The live initiative dir, else the archived one; undefined when neither exists. */
export function initiativeDir(activeRoot: string, slug: string): string | undefined {
  return [path.join(activeRoot, slug), path.join(activeRoot, ARCHIVE, slug)].find((dir) => existsSync(dir));
}

/** The `.md` filenames in a dir, or none when it does not exist. */
export function markdownIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")) : [];
}

/**
 * `<slug>/sources/notes/<file>` is a note, `<slug>/sources/<file>` a source,
 * `<slug>/tasks/<ID>.yml` a task, each also under `archive/`. Anything else has no ref.
 */
export function pathToRef(relative: string): string | undefined {
  const parts = relative.split(path.sep);
  const [slug, kind, ...rest] = parts[0] === ARCHIVE ? parts.slice(1) : parts;
  if (slug === undefined || kind === undefined || rest.length === 0) return undefined;
  if (kind === "sources" && rest[0] === "notes" && rest.length === 2) return `note:${slug}/${rest[1]}`;
  if (kind === "sources" && rest.length === 1) return `source:${slug}/${rest[0]}`;
  if (kind === "tasks" && rest.length === 1 && rest[0]!.endsWith(".yml")) {
    return `task:${path.basename(rest[0]!, ".yml")}`;
  }
  return undefined;
}

/**
 * The workspace-relative path a `note:` or `source:` ref names, the inverse of
 * `pathToRef`. A task ref carries no slug, so it has no path to invert to.
 */
export function refToPath(ref: string, activeRoot: string): string | undefined {
  const match = /^(note|source):([^/]+)\/([^/]+)$/.exec(ref);
  if (match === null) return undefined;
  const [, kind, slug, file] = match;
  const dir = initiativeDir(activeRoot, slug!) ?? path.join(activeRoot, slug!);
  return path.join(path.relative(activeRoot, dir), ...(kind === "note" ? LAYOUT.notes : LAYOUT.sources), file!);
}

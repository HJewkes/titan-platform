import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { HashEmbedder, type Embedder } from "@titan-design/embed";
import { BruteForceVectorIndex, fuseByRRF, vectorRetriever } from "@titan-design/retrieval";
import type { ScoredHit } from "../metrics.js";
import { noteAliases, type Candidate } from "./candidate.js";

/**
 * The vector/hybrid seam: a dense list fused with the lexical one.
 *
 * `HashEmbedder` by default, so the seam runs with no model, no download and no
 * network. It is feature hashing, not semantics — it will not beat FTS on
 * meaning, and is not meant to. What it establishes is the plumbing and a
 * floor: any real embedder swapped in behind `Embedder` has to clear this to
 * justify the dependency.
 */

/** What a vector-only hit would inject, matching the scale of an FTS span. */
const EXCERPT_CHARS = 200;

export interface NoteDocument {
  ref: string;
  text: string;
}

/** Every note in the workspace, archived initiatives included. */
export function loadNotes(activeRoot: string): NoteDocument[] {
  const documents: NoteDocument[] = [];
  for (const { slug, dir } of noteDirs(activeRoot)) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
      documents.push({ ref: `note:${slug}/${file}`, text: readFileSync(path.join(dir, file), "utf8") });
    }
  }
  return documents;
}

function noteDirs(activeRoot: string): { slug: string; dir: string }[] {
  const dirs: { slug: string; dir: string }[] = [];
  const push = (slug: string, base: string) => {
    const dir = path.join(base, "sources", "notes");
    if (existsSync(dir)) dirs.push({ slug, dir });
  };
  for (const entry of readdirSync(activeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name === "archive") {
      const archive = path.join(activeRoot, "archive");
      for (const old of readdirSync(archive, { withFileTypes: true })) {
        if (old.isDirectory()) push(old.name, path.join(archive, old.name));
      }
      continue;
    }
    push(entry.name, path.join(activeRoot, entry.name));
  }
  return dirs;
}

export async function buildIndex(documents: NoteDocument[], embedder: Embedder): Promise<BruteForceVectorIndex> {
  const index = new BruteForceVectorIndex();
  const vectors = await embedder.embed(documents.map((document) => document.text));
  documents.forEach((document, i) => {
    const vector = vectors[i];
    if (vector) index.add(document.ref, vector);
  });
  return index;
}

export interface HybridOptions {
  activeRoot: string;
  /** The lexical half; the hybrid fuses against whatever this returns. */
  lexical: Candidate;
  embedder?: Embedder;
  /** Injectable so a test can build the seam without touching the workspace. */
  documents?: NoteDocument[];
}

/**
 * Over-fetch each list before fusing.
 *
 * RRF can only promote an id some list already ranked, so fusing two top-5
 * lists caps the answer at those ten. Three times the requested depth is the
 * cheapest width that lets the lists disagree and still be reconciled.
 */
const DEPTH_MULTIPLIER = 3;

export async function hybridVector(options: HybridOptions): Promise<Candidate> {
  const embedder = options.embedder ?? new HashEmbedder();
  const documents = options.documents ?? loadNotes(options.activeRoot);
  const index = await buildIndex(documents, embedder);
  const dense = vectorRetriever(embedder, index, { name: "vector" });
  const excerpts = new Map(documents.map((document) => [document.ref, document.text.slice(0, EXCERPT_CHARS).length]));
  return {
    name: "hybrid-fts-vector",
    async search(query, limit, context) {
      const depth = limit * DEPTH_MULTIPLIER;
      const lexical = await options.lexical.search(query, depth, context);
      const vectors = await dense.retrieve(query, { limit: depth });
      return fuse(lexical, vectors, limit, options.activeRoot, excerpts);
    },
    close() {
      options.lexical.close();
    },
  };
}

function fuse(
  lexical: ScoredHit[],
  vectors: { id: string; rank: number }[],
  limit: number,
  activeRoot: string,
  excerpts: Map<string, number>,
): ScoredHit[] {
  const charsOf = new Map(lexical.map((hit) => [hit.id, hit.chars]));
  const fused = fuseByRRF([
    { name: "lexical", hits: lexical.map((hit, i) => ({ id: hit.id, rank: i + 1 })) },
    { name: "vector", hits: vectors },
  ]);
  return fused.slice(0, limit).map((result) => ({
    id: result.id,
    aliases: noteAliases(result.id, activeRoot),
    chars: charsOf.get(result.id) ?? excerpts.get(result.id) ?? 0,
  }));
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { classifyQuestion } from "./classify.js";
import type { LedgerRowWire } from "./ledger.js";
import type { LedgerSource, SourceRead, SourceWatermark, SourceWatermarks } from "./source.js";

/**
 * The decision-notes source, ported from active-work's `src/precedent/notes.ts`. Precedents written
 * down rather than asked: `kind: decision` notes, and Claude Code memories imported as notes whose
 * original type was `feedback`. One watermark per note file, so an unchanged note is never re-parsed.
 */

export const NOTE_SOURCE = "note";

const IMPORT_TRAILER = /\n---\nImported \d{4}-\d{2}-\d{2} from Claude Code memory[\s\S]*$/;
const FEEDBACK_TRAILER = /\(type: feedback\b/;
const MAX_ANSWER_CHARS = 4000;
const OPEN = "---";
const CLOSE = "\n---";

export interface NoteSourceOptions {
  /** The active-work root: one directory per initiative, its notes under `<slug>/sources/notes/`. */
  root: string;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const NoteFrontmatterSchema = z.object({
  kind: z.enum(["process", "gotcha", "fyi", "decision", "plan"]),
  title: z.string().min(1),
  created: z.string().refine(isIsoDate, { message: "Must be a valid zero-padded YYYY-MM-DD date" }),
  tags: z.array(z.string().min(1)).optional(),
});

type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;

interface Note {
  slug: string;
  filename: string;
  path: string;
  frontmatter: NoteFrontmatter;
  body: string;
}

/** The ledger key; identical to active-work's v1 key so its `precedents.jsonl` rows dedupe with these. */
export function noteKey(slug: string, filename: string): string {
  return `note:${slug}/${filename}`;
}

/** Splits frontmatter from body the way gray-matter does, which active-work's loader used. */
function splitFrontmatter(raw: string): { data: unknown; body: string } {
  if (!raw.startsWith(OPEN)) return { data: {}, body: raw };
  const rest = raw.slice(OPEN.length);
  const close = rest.indexOf(CLOSE);
  if (close === -1) return { data: parseYaml(rest), body: "" };
  const body = rest.slice(close + CLOSE.length).replace(/^\r?\n/, "");
  return { data: parseYaml(rest.slice(0, close)), body };
}

function isPrecedentNote(frontmatter: NoteFrontmatter, body: string): boolean {
  if (frontmatter.kind === "decision") return true;
  const tags = frontmatter.tags ?? [];
  if (!tags.includes("memory-import")) return false;
  return tags.includes("feedback") || FEEDBACK_TRAILER.test(body);
}

function noteRow(note: Note): LedgerRowWire {
  const title = note.frontmatter.title;
  return {
    key: noteKey(note.slug, note.filename),
    v: 2,
    source: "note",
    asked_at: note.frontmatter.created,
    locator: { path: note.path },
    initiative: note.slug,
    category: classifyQuestion({ header: "", question: title, options: [] }),
    header: null,
    question: title,
    options: [],
    recommended: null,
    answer: note.body.replace(IMPORT_TRAILER, "").trim().slice(0, MAX_ANSWER_CHARS),
    outcome: "none",
  };
}

async function listDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function listNoteFiles(notesDir: string): Promise<string[]> {
  try {
    return (await readdir(notesDir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

function watermarkOf(bytes: Buffer): SourceWatermark {
  return { offset: bytes.length, prefixHash: createHash("sha256").update(bytes).digest("hex") };
}

function sameWatermark(a: SourceWatermark, b: SourceWatermark | undefined): boolean {
  return b !== undefined && a.offset === b.offset && a.prefixHash === b.prefixHash;
}

function parseNote(slug: string, filename: string, filePath: string, raw: string): Note {
  const { data, body } = splitFrontmatter(raw);
  const frontmatter = NoteFrontmatterSchema.parse(data);
  return { slug, filename, path: filePath, frontmatter, body };
}

async function readNote(slug: string, filename: string, filePath: string, since: SourceWatermarks, out: SourceRead): Promise<void> {
  const cursor = `${slug}/${filename}`;
  const bytes = await readFile(filePath);
  const watermark = watermarkOf(bytes);
  if (sameWatermark(watermark, since.get(cursor))) return;
  out.watermarks.set(cursor, watermark);
  const note = parseNote(slug, filename, filePath, bytes.toString("utf8"));
  if (isPrecedentNote(note.frontmatter, note.body)) out.candidates.push({ row: noteRow(note), cwd: null });
}

async function readInitiative(root: string, slug: string, since: SourceWatermarks, out: SourceRead): Promise<void> {
  const notesDir = path.join(root, slug, "sources", "notes");
  for (const filename of await listNoteFiles(notesDir)) {
    const filePath = path.join(notesDir, filename);
    try {
      await readNote(slug, filename, filePath, since, out);
    } catch (err) {
      out.errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** A note's cursor is `<slug>/<filename>`; a malformed note is reported once per content change. */
export function noteSource(options: NoteSourceOptions): LedgerSource {
  return {
    name: NOTE_SOURCE,
    async read(since: SourceWatermarks): Promise<SourceRead> {
      const out: SourceRead = { candidates: [], watermarks: new Map(), pending: 0, errors: [] };
      for (const slug of await listDirs(options.root)) await readInitiative(options.root, slug, since, out);
      return out;
    },
  };
}

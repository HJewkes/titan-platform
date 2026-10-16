import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { countOccurrences, plainText, splitLinks } from "./markup.js";

const PinEntrySchema = z.object({
  source: z.string(),
  rewrite: z.string(),
  rewriter: z.string(),
  createdAt: z.string(),
});

/** The `rewrites.json` file: accepted rewrites keyed by {@link pinKey} of the sentence they replace. */
export const RewritePinsSchema = z.object({
  version: z.literal(1),
  pins: z.record(z.string(), PinEntrySchema),
});
export type RewritePinsFile = z.infer<typeof RewritePinsSchema>;

export interface RewritePinsOptions {
  now?: () => Date;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Key of a pin. It covers the sentence only, so swapping the rewriter keeps reviewed pins; the rewriter id
 * is stored in the entry instead (D-T13-4, pending the owner's answer).
 */
export function pinKey(sentence: string): string {
  return createHash("sha256").update(collapse(sentence)).digest("hex");
}

export class RewritePins {
  private readonly pins: Record<string, z.infer<typeof PinEntrySchema>>;
  private readonly now: () => Date;

  constructor(file?: RewritePinsFile, options: RewritePinsOptions = {}) {
    this.pins = { ...file?.pins };
    this.now = options.now ?? (() => new Date());
  }

  static fromJson(json: unknown, options?: RewritePinsOptions): RewritePins {
    return new RewritePins(RewritePinsSchema.parse(json), options);
  }

  /** A missing file is an empty store; a malformed or wrong-version file throws rather than losing pins. */
  static async load(path: string, options?: RewritePinsOptions): Promise<RewritePins> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new RewritePins(undefined, options);
      throw error;
    }
    return RewritePins.fromJson(JSON.parse(raw), options);
  }

  toJson(): RewritePinsFile {
    return { version: 1, pins: { ...this.pins } };
  }

  /** Writes beside the target and renames, so a crash never leaves a half-written pin file. */
  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.toJson(), null, 2)}\n`);
    await rename(tmp, path);
  }

  get(sentence: string): string | undefined {
    return this.pins[pinKey(sentence)]?.rewrite;
  }

  put(sentence: string, rewrite: string, rewriterId: string): void {
    this.pins[pinKey(sentence)] = {
      source: sentence,
      rewrite,
      rewriter: rewriterId,
      createdAt: this.now().toISOString(),
    };
  }

  isPinnedRewrite(text: string): boolean {
    const wanted = collapse(text);
    return Object.values(this.pins).some((entry) => collapse(entry.rewrite) === wanted);
  }

  /** Removes pins whose source sentence is not in `inUse`; returns how many went. */
  prune(inUse: Set<string>): number {
    const keep = new Set([...inUse].map(pinKey));
    let removed = 0;
    for (const key of Object.keys(this.pins)) {
      if (keep.has(key)) continue;
      delete this.pins[key];
      removed += 1;
    }
    return removed;
  }
}

export class UnpinnedRewriteError extends Error {
  constructor(readonly sentences: string[]) {
    super(`${sentences.length} flagged sentence(s) have no pinned rewrite: ${sentences.join(" | ")}`);
    this.name = "UnpinnedRewriteError";
  }
}

export interface SentencePiece {
  text: string;
  /** The whitespace after the sentence, kept so the pieces join back to the line. */
  gap: string;
}

const BOUNDARY = /(?<=[.?!])\s+/;

/** Splits only inside plain segments, so a period inside `[w](/ph. x/)` markup never ends a sentence. */
export function splitSentences(line: string): SentencePiece[] {
  const pieces: SentencePiece[] = [];
  let open = "";
  for (const segment of splitLinks(line)) {
    if (segment.kind === "link") {
      open += segment.text;
      continue;
    }
    let rest = segment.text;
    for (let match = BOUNDARY.exec(rest); match; match = BOUNDARY.exec(rest)) {
      pieces.push({ text: open + rest.slice(0, match.index), gap: match[0] });
      open = "";
      rest = rest.slice(match.index + match[0].length);
    }
    open += rest;
  }
  if (open !== "") pieces.push({ text: open, gap: "" });
  return pieces;
}

const holdsSpan = (sentence: string, spans: readonly string[]): boolean =>
  spans.some((span) => countOccurrences(plainText(sentence), span) > 0);

function substitute(text: string, rewrite: string): string {
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const trail = /\s*$/.exec(text)?.[0] ?? "";
  return lead + rewrite + trail;
}

/** Substitutes every pinned sentence; throws if a sentence holding a flagged span has no pin and is not a pinned rewrite. */
export function applyPins(line: string, pins: RewritePins, flaggedSpans: readonly string[] = []): string {
  const unpinned: string[] = [];
  const out = splitSentences(line).map(({ text, gap }) => {
    const pinned = pins.get(text);
    if (pinned !== undefined) return substitute(text, pinned) + gap;
    if (holdsSpan(text, flaggedSpans) && !pins.isPinnedRewrite(text)) unpinned.push(text.trim());
    return text + gap;
  });
  if (unpinned.length > 0) throw new UnpinnedRewriteError(unpinned);
  return out.join("");
}

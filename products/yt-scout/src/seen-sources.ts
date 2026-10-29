import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { VideoState } from "./store.js";

/** One id found in the pre-scout history, with whatever metadata its file carries. */
export interface SeenRecord {
  id: string;
  state: Extract<VideoState, "seen" | "transcribed" | "scored" | "mined">;
  channel?: string;
  title?: string;
  published?: string;
  duration?: number;
  card?: string;
}

/** What one history file or directory contributed, so a missing one is reported, not silent. */
export interface SeenSourceResult {
  name: string;
  path: string;
  present: boolean;
  records: SeenRecord[];
}

/** The 10-03 and 10-11 artifacts the plan's seen-set names, relative to the youtube sources tree. */
export const SEEN_PATHS = {
  inventory: "ai-channels-2026-10/inventory.jsonl",
  scores: "ai-channels-2026-10/scores",
  watchLater: "watch-later/selected.jsonl",
  facts: "watch-later/facts",
  out: "out",
} as const;

const VIDEO_ID = /^[\w-]{11}$/;

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function readJsonl(file: string): Json[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => [line.trim(), i + 1] as const)
    .filter(([line]) => line !== "")
    .map(([line, n]) => {
      try {
        return JSON.parse(line) as Json;
      } catch {
        throw new Error(`${file}:${n}: not a JSON object`);
      }
    });
}

function withId(rows: Json[]): (Json & { id: string })[] {
  return rows.filter((r): r is Json & { id: string } => typeof r.id === "string" && VIDEO_ID.test(r.id));
}

function result(name: string, file: string, read: () => SeenRecord[]): SeenSourceResult {
  const present = existsSync(file);
  return { name, path: file, present, records: present ? read() : [] };
}

export function readInventory(root: string): SeenSourceResult {
  const file = path.join(root, SEEN_PATHS.inventory);
  return result("inventory", file, () =>
    withId(readJsonl(file)).map((r) => ({
      id: r.id,
      state: "seen",
      channel: str(r.channel),
      title: str(r.title),
      published: str(r.upload_date),
      duration: num(r.duration),
    })),
  );
}

// all-scores.json is the merged set; a batch file can still hold a card it missed.
export function readScores(root: string): SeenSourceResult {
  const dir = path.join(root, SEEN_PATHS.scores);
  return result("scores", dir, () => {
    const allFile = path.join(dir, "all-scores.json");
    const merged = existsSync(allFile) ? (JSON.parse(readFileSync(allFile, "utf8")) as Json[]) : [];
    const batches = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .flatMap((f) => readJsonl(path.join(dir, f)));
    const cards = new Map<string, Json & { id: string }>();
    for (const card of withId([...batches, ...merged])) cards.set(card.id, card);
    return [...cards.values()].map((c) => ({ id: c.id, state: "scored", title: str(c.title), card: JSON.stringify(c) }));
  });
}

export function readWatchLater(root: string): SeenSourceResult {
  const file = path.join(root, SEEN_PATHS.watchLater);
  const factsDir = path.join(root, SEEN_PATHS.facts);
  return result("watch-later", file, () =>
    withId(readJsonl(file)).map((r) => ({
      id: r.id,
      state: existsSync(path.join(factsDir, `${r.id}.md`)) ? "mined" : "seen",
      channel: str(r.channel),
      title: str(r.title),
      published: str(r.upload_date),
    })),
  );
}

function frontMatter(file: string): Json | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(readFileSync(file, "utf8"));
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]!);
  } catch (err) {
    throw new Error(`${file}: front matter is not YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  return parsed && typeof parsed === "object" ? (parsed as Json) : undefined;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.endsWith(".digest.md"))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

export function readTranscripts(root: string): SeenSourceResult {
  const dir = path.join(root, SEEN_PATHS.out);
  return result("out", dir, () =>
    markdownFiles(dir).flatMap((file) => {
      const fm = frontMatter(file);
      const id = str(fm?.id);
      if (!fm || !id || !VIDEO_ID.test(id)) return [];
      return [
        {
          id,
          state: "transcribed" as const,
          channel: str(fm.channel_handle)?.replace(/^@/, "") ?? str(fm.channel),
          title: str(fm.title),
          published: str(fm.uploaded),
          duration: num(fm.duration_seconds),
        },
      ];
    }),
  );
}

export function readSeenSources(root: string): SeenSourceResult[] {
  return [readInventory(root), readScores(root), readWatchLater(root), readTranscripts(root)];
}

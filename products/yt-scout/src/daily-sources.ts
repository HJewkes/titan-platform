import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { depositItemId } from "@titan-design/owner-queue";
import { readAnswer } from "@titan-design/owner-queue/spool";
import type { Watchlist } from "./config.js";
import type { ConsoleResult, ConsoleRunner, DailyCard, DailyDeps, DailyStats } from "./daily.js";
import type { StepRow } from "./step-rows.js";
import type { VideoRow } from "./store.js";

const DAY_MS = 86_400_000;

/** `titan-console` from PATH; the CLI reads `TITAN_CONSOLE_PORT` itself. */
export const shellConsoleRunner: ConsoleRunner = (args, stdin) =>
  new Promise<ConsoleResult>((resolve) => {
    const child = execFile("titan-console", args, { encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout, stderr: code === 1 && !stderr ? String(err?.message ?? "") : stderr });
    });
    child.stdin?.end(stdin ?? "");
  });

export function inboxDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TITAN_CONSOLE_INBOX_DIR) return env.TITAN_CONSOLE_INBOX_DIR;
  const state = env.TITAN_CONSOLE_STATE ?? path.join(os.homedir(), ".local", "state", "titan-console");
  return path.join(state, "inbox", "deposits");
}

export function readOwnerAnswer(dir: string): DailyDeps["readAnswer"] {
  return async (depositId) => (await readAnswer(dir, depositItemId("yt-scout", depositId)))?.text;
}

export function loadRows(rowsDir: string): StepRow[] {
  if (!existsSync(rowsDir)) return [];
  return readdirSync(rowsDir)
    .filter((f) => /^steps-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => readFileSync(path.join(rowsDir, f), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as StepRow);
}

const scored = (r: StepRow): boolean => r.step === "score" && (r.outcome === "ok" || r.outcome === "fallback") && r.output_path !== null;

interface StoredCardFile {
  id: string;
  title: string;
  actionable: number;
  novelty: number;
  evidence: number;
  total: number;
  summary: string;
  techniques: { ts: string; what: string }[];
  prompt_sha: string;
  model: string;
}

interface CardLookup {
  sourceName(key: string | null): string;
  duration(id: string): number | null;
}

function toCard(row: StepRow, lookup: CardLookup): DailyCard | undefined {
  const file = row.output_path!;
  if (!existsSync(file)) return undefined;
  const c = JSON.parse(readFileSync(file, "utf8")) as StoredCardFile;
  const digest = path.join(path.dirname(file), `${c.id}.digest.md`);
  const seconds = lookup.duration(c.id);
  return {
    ...c,
    sourceName: lookup.sourceName(row.source),
    durationMinutes: seconds === null ? null : Math.round(seconds / 60),
    transcriptPath: path.join(path.dirname(file), `${c.id}.md`),
    inputSha: row.input_sha,
    ...(existsSync(digest) ? { digestPath: digest } : {}),
  };
}

export function sourceCardLoaders(rowsDir: string, watchlist: Watchlist, video: (id: string) => VideoRow | undefined, now: () => Date) {
  const lookup: CardLookup = {
    sourceName: (key) => watchlist.sources.find((s) => s.key === key)?.name ?? key ?? "unknown",
    duration: (id) => video(id)?.duration ?? null,
  };
  const latestPerVideo = (rows: StepRow[]): StepRow[] => [...new Map(rows.map((r) => [r.video_id, r])).values()];
  const since = (): number => now().getTime() - DAY_MS;
  return {
    async cards(): Promise<DailyCard[]> {
      const recent = loadRows(rowsDir).filter((r) => scored(r) && Date.parse(r.started_at) >= since());
      return latestPerVideo(recent).flatMap((r) => toCard(r, lookup) ?? []);
    },
    async findCard(id: string): Promise<DailyCard | undefined> {
      const row = latestPerVideo(loadRows(rowsDir).filter((r) => scored(r) && r.video_id === id))[0];
      return row ? toCard(row, lookup) : undefined;
    },
    async stats(): Promise<DailyStats> {
      const recent = loadRows(rowsDir).filter((r) => Date.parse(r.started_at) >= since());
      const failed = new Set(recent.filter((r) => r.outcome === "fail").map((r) => r.video_id));
      return { failed: failed.size, spendUsd: recent.reduce((sum, r) => sum + r.cost_usd, 0) };
    },
  };
}

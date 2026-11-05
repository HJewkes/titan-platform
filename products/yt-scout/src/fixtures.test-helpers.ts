import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Synthetic only: made-up ids, titles and channels. Never copy real transcript text here.

export const VALID_WATCHLIST = `version: 1
defaults: { poll: 1h, tabs: [videos], min_seconds: 180, max_seconds: 18000 }
sources:
  - key: confTalks
    name: Conference Talks
    channel_id: UCaaaaaaaaaaaaaaaaaaaaaa
    handle: confTalks
  - key: vendor
    name: Vendor Channel
    channel_id: UCbbbbbbbbbbbbbbbbbbbbbb
    poll: 6h
    trial_until: 2026-11-27
  - key: speaker
    name: Speaker (search)
    search: '"Jane Speaker"'
    match: 'jane speaker'
    poll: 24h
scoring: { threshold_total: 10, also_if_any_axis: 5, daily_top: 3 }
budget: { daily_usd: 2.00, backfill_usd: 25.00 }
models: { score: model-a, digest: model-b }
`;

export interface TempTree {
  root: string;
  write(relPath: string, text: string): void;
  cleanup(): void;
}

export function tempTree(): TempTree {
  const root = mkdtempSync(path.join(os.tmpdir(), "yt-scout-"));
  return {
    root,
    write(relPath, text) {
      const file = path.join(root, relPath);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const jsonl = (rows: object[]): string => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n\n`;

const card = (id: string, total: number) => ({ id, title: `Talk ${id}`, actionable: 4, novelty: 3, evidence: total - 7, summary: "Synthetic.", techniques: [], total });

const transcript = (id: string, handle: string) =>
  `---\nid: "${id}"\ntitle: "Talk ${id}"\nchannel_handle: "@${handle}"\nuploaded: "2026-10-01"\nduration_seconds: 600\n---\n\nSynthetic paragraph.\n`;

/**
 * A seen-set tree whose expected result is: scored aaaaaaaaa01, aaaaaaaaa02, aaaaaaaaa03;
 * seen aaaaaaaaa04, aaaaaaaaa05, wwwwwwwww02; mined wwwwwwwww01; transcribed ttttttttt01.
 */
export function writeSeenTree(tree: TempTree): void {
  tree.write(
    "ai-channels-2026-10/inventory.jsonl",
    jsonl([
      { id: "aaaaaaaaa01", title: "Talk one", channel: "confTalks", duration: 1200, upload_date: "2026-09-30" },
      { id: "aaaaaaaaa02", title: "Talk two", channel: "confTalks", duration: 900, upload_date: "2026-09-29" },
      { id: "aaaaaaaaa03", title: "Talk three", channel: "Unlisted Person", duration: 600, upload_date: "2026-09-28" },
      { id: "aaaaaaaaa04", title: "Talk four", channel: "Vendor Channel", duration: 300, upload_date: "2026-09-27" },
      { id: "aaaaaaaaa05", title: "Talk five", channel: "Unlisted Person", duration: 60, upload_date: "2026-09-26" },
      { id: "not-an-id", title: "Skipped", channel: "x" },
    ]),
  );
  tree.write("ai-channels-2026-10/scores/all-scores.json", JSON.stringify([card("aaaaaaaaa01", 12), card("aaaaaaaaa02", 9)]));
  tree.write("ai-channels-2026-10/scores/batch-1.jsonl", jsonl([card("aaaaaaaaa02", 5), card("aaaaaaaaa03", 7)]));
  tree.write(
    "watch-later/selected.jsonl",
    jsonl([
      { id: "wwwwwwwww01", title: "Saved one", channel: "Conference Talks", upload_date: null },
      { id: "wwwwwwwww02", title: "Saved two", channel: "Elsewhere", upload_date: null },
      { id: "aaaaaaaaa01", title: "Talk one", channel: "Conference Talks", upload_date: null },
    ]),
  );
  tree.write("watch-later/facts/wwwwwwwww01.md", "synthetic facts\n");
  tree.write("watch-later/facts/aaaaaaaaa01.md", "synthetic facts\n");
  tree.write("out/confTalks/aaaaaaaaa03.md", transcript("aaaaaaaaa03", "confTalks"));
  tree.write("out/elsewhere/ttttttttt01.md", transcript("ttttttttt01", "elsewhere"));
  tree.write("out/elsewhere/ttttttttt01.digest.md", transcript("ddddddddd01", "elsewhere"));
  tree.write("out/elsewhere/notes.md", "no front matter here\n");
}

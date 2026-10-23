import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { gatherArticle, type GatherArticleResult } from "./presets/article/gather-article.js";
import { StoryboardSchema, type Storyboard } from "./storyboard.js";

// The demo article fixture: one article, its claims and a storyboard that passes every paper publish check.

const DEMO = fileURLToPath(new URL("../fixtures/article/demo", import.meta.url));

const DEMO_ARTICLE = join(DEMO, "article.md");

export type Beats = Storyboard["beats"];

const demoClaims = (): unknown[] => z.array(z.unknown()).parse(JSON.parse(readFileSync(join(DEMO, "claims.json"), "utf8")));

export const gatherDemo = (): Promise<GatherArticleResult> => gatherArticle({ articlePath: DEMO_ARTICLE, label: "Fewer Rounds by Design", claims: demoClaims() });

export const demoBoard = (): Storyboard => StoryboardSchema.parse(JSON.parse(readFileSync(join(DEMO, "beats.json"), "utf8")));

export function edited(change: (beats: Beats) => void): Storyboard {
  const next = demoBoard();
  change(next.beats);
  return next;
}

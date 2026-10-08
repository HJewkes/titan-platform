import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectDigest, type DigestSources } from "./collect.js";
import type { DigestSlot } from "./model.js";
import { DEFAULT_CAPS, NO_CAPS, rankDigest } from "./rank.js";
import { renderMarkdown } from "./render-md.js";
import type { Directories } from "./sources.js";

export interface DigestRun {
  sources: DigestSources;
  now: Date;
  slot: DigestSlot;
  windowMinutes: number;
  full: boolean;
}

export async function buildDigest({ sources, now, slot, windowMinutes, full }: DigestRun): Promise<string> {
  const model = await collectDigest({ sources, now, slot, windowMinutes });
  return renderMarkdown(rankDigest(model, full ? NO_CAPS : DEFAULT_CAPS));
}

export interface Delivery {
  written: string[];
  warnings: string[];
}

/** The slot names the file, so a rerun for the same slot replaces it; a failed copy warns but keeps the local file. */
export function deliverDigest(markdown: string, slot: DigestSlot, dirs: Directories): Delivery {
  const name = `${slot.date}-${slot.hour}.md`;
  const write = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), markdown);
    return join(dir, name);
  };
  const written = [write(dirs.outDir)];
  const warnings: string[] = [];
  for (const dir of dirs.copyDirs) {
    try {
      written.push(write(dir));
    } catch (error) {
      warnings.push(`copy to ${dir} failed: ${(error as Error).message}`);
    }
  }
  return { written, warnings };
}

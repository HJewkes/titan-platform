import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { seatConfigSchema, type SeatConfig } from "@titan-design/coordinator";
import type { Limits } from "./import.js";

/** The coordinator package's synthetic example tree: charter.md, seat-a.md and seat-b.md. */
export const FIXTURE_TREE = fileURLToPath(new URL("../../../../packages/coordinator/src/fixtures/autonomy-tree/", import.meta.url));

const pool = (name: string) => ({ config_dir: `/home/user/cfg/${name}`, ceiling_five_hour: 90, reserve_seven_day: 20 });

/** The fixture charter has no pools block, so its pools come from here, matching the seats' config_dir. */
export const FIXTURE_LIMITS: Limits = { version: 1, pools: { "pool-a": pool("pool-a"), "pool-b": pool("pool-b"), "pool-c": pool("pool-c") } };

export function tempDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `config-store-${label}-`));
}

/** A copy of the fixture tree a test may edit. */
export function copyFixtureTree(): string {
  const tree = path.join(tempDir("tree"), "autonomy");
  cpSync(FIXTURE_TREE, tree, { recursive: true });
  return tree;
}

function frontMatterJson(tree: string, file: string): unknown {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path.join(tree, file), "utf8"));
  if (!match) throw new Error(`${file} has no front matter`);
  return JSON.parse(match[1] ?? "");
}

/** A seat file's front matter, parsed as the JSON the fixture writes it in. */
export function fixtureSeat(tree: string, file: string): SeatConfig {
  return seatConfigSchema.parse(frontMatterJson(tree, file));
}

/** The charter's front matter with every key kept. */
export function fixtureCharter(tree: string): Record<string, unknown> {
  return z.looseObject({}).parse(frontMatterJson(tree, "charter.md"));
}

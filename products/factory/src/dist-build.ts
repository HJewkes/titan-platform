import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deployedBinPath } from "./deploy-checkout.js";

/** esbuild inlines the define into `buildSha()` as a bare `return "<sha>";`, the only place the bundle spells it. */
const BAKED_SHA = /function buildSha\(\) \{\s*return "([0-9a-f]{40}(?:-dirty)?|unknown)";/;

export const bakedShaOf = (bundleText: string): string | undefined => BAKED_SHA.exec(bundleText)?.[1];

/**
 * The build sha baked into the dist a restart would run. A restart rebuilds nothing, so this is the
 * truth even when the checkout's HEAD is ahead of dist (a rolled-back deploy restores dist only).
 * Undefined when the dist is absent or predates the bake.
 */
export function distBuildSha(checkout: string): string | undefined {
  const dist = join(deployedBinPath(checkout), "..");
  try {
    for (const file of readdirSync(dist).filter((name) => name.endsWith(".js"))) {
      const sha = bakedShaOf(readFileSync(join(dist, file), "utf8"));
      if (sha !== undefined) return sha;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

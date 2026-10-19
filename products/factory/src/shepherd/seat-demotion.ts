import { configPath, loadConfig } from "../config.js";
import { DEFAULT_VISUAL_DEMOTION, type VisualDemotion } from "./auto-pass.js";
import { loadSeatBook, seatBaselineGlobs, type SeatBook } from "./seats.js";

/**
 * The D2 guard for `repo`, built from the seat book as it reads at decision time: every baseline glob any seat on the
 * remote declares joins the paths the owner reviews. A book that cannot be read keeps every visual gate for the owner.
 */
export function seatVisualDemotion(seats: () => SeatBook, repo: string, demotion: VisualDemotion | null = DEFAULT_VISUAL_DEMOTION): VisualDemotion | null {
  if (demotion === null) return null;
  let globs: string[];
  try {
    globs = seatBaselineGlobs(seats(), repo);
  } catch {
    return null;
  }
  return globs.length === 0 ? demotion : { ...demotion, ownerPaths: [...new Set([...demotion.ownerPaths, ...globs])] };
}

/** `seatVisualDemotion` over the configured seat book, re-read per call as registration reads it. */
export function configuredVisualDemotion(repo: string, env: NodeJS.ProcessEnv = process.env): VisualDemotion | null {
  return seatVisualDemotion(() => loadSeatBook(loadConfig(configPath(env)).shepherd ?? {}), repo);
}

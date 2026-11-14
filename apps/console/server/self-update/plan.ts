import path from "node:path";
import { touchedPaths as sharedTouchedPaths } from "@titan-design/daemon";
import { z } from "zod";

const CONSOLE_PACKAGE = "titan-console";
/** pnpm's own view of the workspace packages the console build reaches, so a new dependency needs no list edit here. */
export const CLOSURE_ARGS: readonly string[] = ["--filter", `${CONSOLE_PACKAGE}...`, "ls", "--depth", "-1", "--json"];

/**
 * The closure dirs relative to `root`, from `pnpm ls --json` run there. Undefined when the output is not the
 * array pnpm prints, so an unreadable graph counts every change as a console change rather than none.
 */
export function closureDirs(lsJson: string, root: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lsJson);
  } catch {
    return undefined;
  }
  const entries = z.array(z.object({ path: z.string() })).safeParse(parsed);
  if (!entries.success) return undefined;
  const dirs = entries.data.map((entry) => path.relative(root, entry.path).split(path.sep).join("/"));
  return dirs.length === 0 || dirs.some((dir) => dir === "" || dir.startsWith("..")) ? undefined : dirs.sort();
}

/** The changed paths the console build reads; an unknown closure keeps every path. */
export function touchedPaths(changed: readonly string[], closure: readonly string[] | undefined): string[] {
  if (closure === undefined) return [...changed];
  return sharedTouchedPaths(changed, closure);
}

import path from "node:path";
import { z } from "zod";

const CONSOLE_PACKAGE = "titan-console";
/** pnpm's own view of the workspace packages the console build reaches, so a new dependency needs no list edit here. */
export const CLOSURE_ARGS: readonly string[] = ["--filter", `${CONSOLE_PACKAGE}...`, "ls", "--depth", "-1", "--json"];
export const BUILD_ARGS: readonly string[] = ["--filter", `${CONSOLE_PACKAGE}...`, "build"];

/** Root files every workspace build reads; a lockfile bump for an unrelated package over-triggers, which costs one rebuild. */
const ROOT_BUILD_INPUTS: readonly string[] = ["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", ".npmrc"];
const ROOT_TSCONFIG = /^tsconfig[^/]*\.json$/;
/** Files inside a closure package that never reach its dist. */
const NON_RUNTIME = /(\.(test|spec)\.[cm]?tsx?|\.md)$/;

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

const isRootInput = (file: string): boolean => ROOT_BUILD_INPUTS.includes(file) || ROOT_TSCONFIG.test(file);

/** The changed paths the console build reads; an unknown closure keeps every path. */
export function touchedPaths(changed: readonly string[], closure: readonly string[] | undefined): string[] {
  if (closure === undefined) return [...changed];
  return changed.filter((file) => isRootInput(file) || (!NON_RUNTIME.test(file) && closure.some((dir) => file.startsWith(`${dir}/`))));
}

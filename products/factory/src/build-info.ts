import { createRequire } from "node:module";

declare const __FACTORY_BUILD_SHA__: string | undefined;

export const UNKNOWN_BUILD_SHA = "unknown";
/** tsup.config.ts appends this to the baked sha when the checkout had uncommitted changes. */
export const DIRTY_SUFFIX = "-dirty";
/** What a /health probe field reads before its first gh call lands. */
export const PROBE_PENDING = "checking";

/** The git sha tsup baked in; `unknown` when the define is absent (vitest, unbuilt source) or empty. */
export function buildSha(): string {
  return (typeof __FACTORY_BUILD_SHA__ === "string" && __FACTORY_BUILD_SHA__) || UNKNOWN_BUILD_SHA;
}

/** `owner/name` from a GitHub repository url such as `git+https://github.com/owner/name.git`; undefined for any other url. */
export function repoSlugOf(url: string): string | undefined {
  return /^(?:git\+)?(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}

const { repository } = createRequire(import.meta.url)("../package.json") as { repository?: { url?: string } };

/** The repo this factory is built from, read from its package.json; Shepherd redeploys only after merges there. */
export const FACTORY_REPO: string | undefined = repoSlugOf(repository?.url ?? "");

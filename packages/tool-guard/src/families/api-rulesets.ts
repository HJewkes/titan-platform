import { asciiDecoded, placeholderRoutes, routedPath } from "./api-branch-refs.js";

type SettingsRoute = "rulesets" | "branch-protection";
type SettingsScope = "repo" | "repository-id" | "org" | "enterprise" | "unknown";

/** A GitHub REST write to a ruleset or to a branch's protection: the `ruleset-write` hard stop. */
export interface SettingsWrite {
  route: SettingsRoute;
  scope: SettingsScope;
}

/**
 * Anchored on a path segment as `REPO_ROUTE_RE` is, so full api.github.com and GHES `api/v3` URLs match too. Every
 * method but GET and HEAD denies, so a sub-path GitHub adds later (`rulesets/<id>/…`) cannot open a hole.
 */
const SETTINGS_ROUTES: [RegExp, SettingsRoute, SettingsScope][] = [
  [/(?:^|\/)repos\/[^/]+\/[^/]+\/rulesets(?:\/|$)/i, "rulesets", "repo"],
  [/(?:^|\/)repositories\/[^/]+\/rulesets(?:\/|$)/i, "rulesets", "repository-id"],
  [/(?:^|\/)orgs\/[^/]+\/rulesets(?:\/|$)/i, "rulesets", "org"],
  [/(?:^|\/)enterprises\/[^/]+\/rulesets(?:\/|$)/i, "rulesets", "enterprise"],
  [/(?:^|\/)repos\/[^/]+\/[^/]+\/branches\/.+\/protection(?:\/|$)/i, "branch-protection", "repo"],
  [/(?:^|\/)repositories\/[^/]+\/branches\/.+\/protection(?:\/|$)/i, "branch-protection", "repository-id"],
];

const LOOSE_SETTINGS_RE = /\/(?:rulesets|protection)(?:\/|$)/i;

/**
 * A path whose route is unsure reads as the route its raw text loosely names. A gh placeholder that can change the
 * route may supply all of it, so that write always reads as unknown.
 */
function unsureWrite(url: string): SettingsWrite | null {
  const unqueried = url.replace(/[?#].*$/s, "");
  const raw = asciiDecoded(unqueried);
  if (!LOOSE_SETTINGS_RE.test(raw) && !placeholderRoutes(unqueried)) return null;
  const route = /\/rulesets(?:\/|$)/i.test(raw) ? "rulesets" : "branch-protection";
  return { route, scope: "unknown" };
}

/**
 * A write to a ruleset (`repos/<o>/<r>`, `repositories/<id>`, `orgs/<o>` or `enterprises/<e>`) or to
 * `branches/<b>/protection` on any branch. Any method but GET and HEAD is a write; a null method is one.
 */
export function apiSettingsWrite(url: string, method: string | null): SettingsWrite | null {
  const verb = method?.toUpperCase() ?? null;
  if (verb === "GET" || verb === "HEAD") return null;
  const path = routedPath(url, LOOSE_SETTINGS_RE);
  if (path === null) return null;
  if (path === "unsure") return unsureWrite(url);
  const hit = SETTINGS_ROUTES.find(([re]) => re.test(path));
  return hit ? { route: hit[1], scope: hit[2] } : null;
}

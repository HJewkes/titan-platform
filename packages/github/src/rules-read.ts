import { GhError } from "./exec.js";
import type { RequiredChecks } from "./port.js";
import type { Rest } from "./rest.js";

export interface GhRule {
  type: string;
  ruleset_id?: number;
  parameters?: { required_approving_review_count?: number; require_code_owner_review?: boolean; required_review_thread_resolution?: boolean; required_reviewers?: unknown[]; strict_required_status_checks_policy?: boolean; required_status_checks?: { context: string; integration_id?: number | null }[] };
}

const NO_REQUIRED_CHECKS: RequiredChecks = { contexts: [], strict: false };

/** A private repo on the free plan answers 403 "Upgrade to GitHub Pro" for its rules: it has none. Any other 403 is a real refusal. */
function isFreePlanRefusal(error: unknown): boolean {
  if (!(error instanceof GhError) || error.status !== 403) return false;
  return /Upgrade to GitHub Pro/.test(`${error.result.stdout}\n${error.result.stderr}`);
}

export async function branchRules(api: Rest, repo: string, branch: string): Promise<RequiredChecks> {
  let rules: unknown;
  try {
    rules = await api.get<unknown>(`repos/${repo}/rules/branches/${branch}`);
  } catch (error) {
    if (isFreePlanRefusal(error)) return { ...NO_REQUIRED_CHECKS };
    throw error;
  }
  if (!Array.isArray(rules)) throw new Error("branch rules answered an unexpected shape, so the required contexts are unknown");
  return requiredChecksFrom(rules);
}

function requiredChecksFrom(rules: readonly GhRule[]): RequiredChecks {
  const statusRules = rules.filter((rule) => rule.type === "required_status_checks");
  if (statusRules.some((rule) => !Array.isArray(rule.parameters?.required_status_checks))) {
    throw new Error("a required_status_checks rule has no required_status_checks list, so the required contexts are unknown");
  }
  const contexts = new Set(statusRules.flatMap((rule) => rule.parameters?.required_status_checks?.map((check) => check.context) ?? []));
  const pins = pinsOf(statusRules.flatMap((rule) => (rule.parameters?.required_status_checks ?? []).map((check) => [check.context, check.integration_id] as const)));
  return { contexts: [...contexts].sort(), strict: statusRules.some((rule) => rule.parameters?.strict_required_status_checks_policy === true), ...pins };
}

/** Only a positive app id pins; classic protection spells "any app" as -1. */
function pinsOf(entries: readonly (readonly [string, number | null | undefined])[]): { pins?: Record<string, number[]> } {
  const pins: Record<string, number[]> = {};
  for (const [context, app] of entries) {
    if (typeof app === "number" && app > 0 && !pins[context]?.includes(app)) (pins[context] ??= []).push(app);
  }
  return Object.keys(pins).length > 0 ? { pins } : {};
}

interface GhClassicChecks {
  strict?: boolean;
  contexts?: string[];
  checks?: { context: string; app_id?: number | null }[];
}

/** A 404 or a free-plan 403 means the branch has no classic protection; any other failure propagates, so it never reads as "none". */
export async function classicRequiredChecks(api: Rest, repo: string, branch: string): Promise<RequiredChecks> {
  let body: unknown;
  try {
    body = await api.get<unknown>(`repos/${repo}/branches/${branch}/protection/required_status_checks`);
  } catch (error) {
    if ((error instanceof GhError && error.status === 404) || isFreePlanRefusal(error)) return { ...NO_REQUIRED_CHECKS };
    throw error;
  }
  if (!isObject(body)) throw new Error("classic protection answered an unexpected shape, so the required contexts are unknown");
  const contexts = [...new Set([...(body.contexts ?? []), ...(body.checks ?? []).map((check) => check.context)])].sort();
  return { contexts, strict: body.strict === true, ...pinsOf((body.checks ?? []).map((check) => [check.context, check.app_id] as const)) };
}

/** GitHub's JSON is trusted for field types once it is an object; only the shape it has to be is checked. */
function isObject(value: unknown): value is GhClassicChecks {
  return typeof value === "object" && value !== null;
}

import type { GitHubPort, RepoSlug, RequiredChecks } from "@titan-design/github";

export type RequiredChecksRead = { readable: true; checks: RequiredChecks } | { readable: false; reason: string };

/** Only the HTTP status, so a reason that reaches a PR comment carries nothing from the error's text. */
export function statusOf(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `HTTP ${status}` : "no HTTP status";
}

function wellFormed(value: unknown): value is RequiredChecks {
  const checks = value as Partial<RequiredChecks> | null | undefined;
  return Array.isArray(checks?.contexts) && checks.contexts.every((context) => typeof context === "string") && typeof checks.strict === "boolean";
}

/** An empty list is a read; an error, a 403, a 404 or a malformed answer is not, and must never pass for "no rules". */
export async function readRequiredChecks(port: GitHubPort, repo: RepoSlug, base: string): Promise<RequiredChecksRead> {
  try {
    const checks = await port.requiredChecks(repo, base);
    if (wellFormed(checks)) return { readable: true, checks };
    return { readable: false, reason: `required checks of ${repo}@${base} are unreadable: the answer is malformed` };
  } catch (error) {
    return { readable: false, reason: `required checks of ${repo}@${base} are unreadable: ${statusOf(error)}` };
  }
}

/** For land steps: an unreadable answer stops the step, so the run never proceeds on unknown rules. */
export async function requireRequiredChecks(port: GitHubPort, repo: RepoSlug, base: string): Promise<RequiredChecks> {
  const read = await readRequiredChecks(port, repo, base);
  if (!read.readable) throw new Error(`${read.reason}; land refuses`);
  return read.checks;
}

/** Classic branch protection's required status checks; a 404 reads as none, and any other failure is unreadable. */
export async function readClassicRequiredChecks(port: GitHubPort, repo: RepoSlug, base: string): Promise<RequiredChecksRead> {
  try {
    const checks = await port.classicRequiredChecks(repo, base);
    if (wellFormed(checks)) return { readable: true, checks };
    return { readable: false, reason: `classic protection of ${repo}@${base} is unreadable: the answer is malformed` };
  } catch (error) {
    return { readable: false, reason: `classic protection of ${repo}@${base} is unreadable: ${statusOf(error)}` };
  }
}

/** Rulesets first, then classic protection only when the rulesets require nothing, as premerge reads them. */
export async function readBaseRequiredChecks(port: GitHubPort, repo: RepoSlug, base: string): Promise<RequiredChecksRead> {
  const rulesets = await readRequiredChecks(port, repo, base);
  if (!rulesets.readable || rulesets.checks.contexts.length > 0) return rulesets;
  return readClassicRequiredChecks(port, repo, base);
}

/**
 * The only module in this package that reads `process.env`. A stray
 * `ANTHROPIC_API_KEY` silently outranks `CLAUDE_CODE_OAUTH_TOKEN` and routes a
 * headless run onto metered API billing; the invariants here exist because that
 * cost real money once.
 */

/** Set by a parent Claude Code session; the child CLI refuses to start when it inherits them. */
export const ANTI_NESTING_VARS = ["CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT"] as const;

/** Metered-billing credentials, stripped unless the caller opts in explicitly. */
export const STRIPPED_AUTH_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/**
 * The only `CLAUDE_CODE_*` variables a child may inherit. Everything else in
 * that namespace describes the *parent* session (exec path, terminal, entry
 * point) and confuses the child's credential and config inference.
 */
export const CLAUDE_CODE_PASSTHROUGH_VARS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_MAX_RETRIES",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
] as const;

/** Proxy settings leak from the parent shell and silently re-route the child's API traffic. */
export const STRIPPED_PROXY_VARS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/** The CLI retries 10 times by default, which turns an outage into a long silent hang. */
export const DEFAULT_MAX_RETRIES = "3";

export interface PrepareEnvOptions {
  /** Leave `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in place and bill the API account. */
  allowApiKeyBilling?: boolean;
}

export class AuthMisconfiguredError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "AuthMisconfiguredError";
    this.hint = hint;
  }
}

/**
 * Copy `env` and scrub it into something safe to hand a child Claude Code
 * process. Never mutates its argument, so the result can go straight to
 * `options.env`.
 */
export function prepareEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: PrepareEnvOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const passthrough = new Set<string>(CLAUDE_CODE_PASSTHROUGH_VARS);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isClaudeCodeVar(key) && !passthrough.has(key)) continue;
    out[key] = value;
  }

  for (const key of ANTI_NESTING_VARS) delete out[key];
  for (const key of STRIPPED_PROXY_VARS) delete out[key];
  if (!options.allowApiKeyBilling) {
    for (const key of STRIPPED_AUTH_VARS) delete out[key];
  }

  out.CLAUDE_CODE_MAX_RETRIES ??= DEFAULT_MAX_RETRIES;
  return out;
}

function isClaudeCodeVar(key: string): boolean {
  return key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_");
}

/**
 * Pre-flight the scrubbed env so a misrouted run fails before it spends
 * anything, rather than mid-stream with a surprise billing source.
 */
export function assertAuthEnvOk(env: Record<string, string>, options: PrepareEnvOptions = {}): void {
  if (options.allowApiKeyBilling) {
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
      throw new AuthMisconfiguredError(
        "allowApiKeyBilling is set but neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is present",
      );
    }
    return;
  }

  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    throw new AuthMisconfiguredError(
      "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN survived the scrub",
      "pass the env through prepareEnv, or set allowApiKeyBilling to bill the API account on purpose",
    );
  }

  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new AuthMisconfiguredError(
      "CLAUDE_CODE_OAUTH_TOKEN is not set; subscription auth will fail",
      "run `claude setup-token` once and export the printed token",
    );
  }
}

/**
 * Credential sources that mean the run went to metered API billing. A blacklist,
 * not a whitelist: the SDK's `ApiKeySource` union grows, and an unrecognised new
 * member is far more likely to be another benign OAuth-ish route than a billing
 * one. `"env"` is the pre-0.3 spelling of `"ANTHROPIC_API_KEY"`, kept so an
 * older CLI on the PATH still trips the guard.
 */
export const FORBIDDEN_API_KEY_SOURCES: ReadonlySet<string> = new Set(["env", "ANTHROPIC_API_KEY"]);

/** Post-flight on the first `system/init`, the earliest point the real auth route is observable. */
export function assertApiKeySourceAllowed(observed: string | undefined): void {
  if (observed === undefined) {
    throw new AuthMisconfiguredError("the init message carried no apiKeySource; the auth route cannot be verified");
  }
  if (FORBIDDEN_API_KEY_SOURCES.has(observed)) {
    throw new AuthMisconfiguredError(
      `apiKeySource '${observed}' means the run is on env-based API-key billing`,
      "a stray ANTHROPIC_API_KEY most likely overrode CLAUDE_CODE_OAUTH_TOKEN",
    );
  }
}

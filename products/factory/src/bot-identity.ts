import { TokenFileError, trackSecretFile, type TokenFileProblem } from "@titan-design/daemon";
import { octokitClient, parseGitHubToken, rateBudget, type GitHubClient } from "@titan-design/github";
import type { WorkflowCapability } from "@titan-design/workflow";

/**
 * The bot's token file. Fixed in code like `OWNER_KEYS_DIR`: no environment variable, flag or config can point serve
 * elsewhere. Undefined until the owner ratifies a path (TP-3094 A-4 or B-1), so until then serve looks nowhere.
 */
export const BOT_TOKEN_PATH: string | undefined = undefined;

/** The name a workflow step passes to `ctx.capability` to reach the bot. */
export const BOT_CAPABILITY = "github-bot";

/** Keys the bot's throttle limiters apart from the HJewkes login's `user`. */
export const BOT_THROTTLE_ID = "github-bot";

export type BotTokenProblem = TokenFileProblem | "unreadable";

export type BotHealth = { state: "ok" } | { state: "absent" } | { state: "refused"; problem: BotTokenProblem };

/** Blocked carries no client: a bot step has nothing to fall back on, least of all the HJewkes identity. */
export type BotAccess = { state: "ok"; client: GitHubClient } | { state: "blocked"; reason: "absent" | "refused" };

export interface BotHandle {
  access(): BotAccess;
}

export interface BotIdentity {
  /** For `/health.bot`; never holds the token. */
  health(): BotHealth;
  /** Handed only to the workflow runtime, so a step reaches the bot through `ctx.capability(BOT_CAPABILITY)` alone. */
  readonly capabilities: Readonly<Record<string, WorkflowCapability<BotHandle>>>;
}

export interface BotIdentityOptions {
  path?: string | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

type TokenRead = { state: "ok"; token: string } | Exclude<BotHealth, { state: "ok" }>;

/**
 * Read once at start, like the owner keys: the capability vault's secret list is fixed when the runtime is built, so a
 * rotated token would escape its redaction. A rotation therefore needs a restart. Nothing here throws, so serve starts.
 */
export function openBotIdentity(options: BotIdentityOptions = { path: BOT_TOKEN_PATH }): BotIdentity {
  const read = readToken(options.path);
  if (read.state !== "ok") return disabled(read);
  const client = octokitClient({ token: async () => read.token, reauthOn401: false, throttleId: BOT_THROTTLE_ID, budget: rateBudget({ now: options.now }), fetch: options.fetch, now: options.now });
  const access = (): BotAccess => ({ state: "ok", client });
  return { health: () => ({ state: "ok" }), capabilities: { [BOT_CAPABILITY]: { handle: { access }, secrets: [read.token] } } };
}

function disabled(health: Exclude<BotHealth, { state: "ok" }>): BotIdentity {
  const blocked: BotAccess = { state: "blocked", reason: health.state };
  return { health: () => health, capabilities: { [BOT_CAPABILITY]: { handle: { access: () => blocked }, secrets: [] } } };
}

function readToken(path: string | undefined): TokenRead {
  if (path === undefined) return { state: "absent" };
  try {
    return { state: "ok", token: trackSecretFile(path, parseGitHubToken)() };
  } catch (error) {
    if (error instanceof TokenFileError) return { state: "refused", problem: error.problem };
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { state: "absent" };
    return { state: "refused", problem: "unreadable" };
  }
}

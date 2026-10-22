import { TokenFileError, trackSecretFile, type Logger, type TokenFileProblem } from "@titan-design/daemon";
import { octokitClient, parseGitHubToken, rateBudget, type GitExec, type GitHubClient } from "@titan-design/github";
import type { WorkflowCapability } from "@titan-design/workflow";
import { botTokenExpiryWatch, observingFetch } from "./bot-token-expiry.js";
import { publishFingerprint, tokenFingerprint } from "./bot-token-fingerprint.js";
import { usageMeter, type UsageMeter } from "./github-api/usage-meter.js";
import { botLsRemote, type BotLsRemote } from "./bot-ls-remote.js";

/**
 * The bot's token file. Fixed in code like `OWNER_KEYS_DIR`: no environment variable, flag or config can point serve
 * elsewhere. Undefined until the owner ratifies a path (TP-3094 A-4 or B-1), so until then serve looks nowhere.
 */
export const BOT_TOKEN_PATH: string | undefined = undefined;

/** The bot's GitHub login, fixed in code beside its token path, so C7 can tell its writes apart. Undefined until ratified. */
export const BOT_LOGIN: string | undefined = undefined;

/** The name a workflow step passes to `ctx.capability` to reach the bot. */
export const BOT_CAPABILITY = "github-bot";

/** Keys the bot's throttle limiters apart from the user login's `user`. */
const BOT_THROTTLE_ID = "github-bot";

type BotTokenProblem = TokenFileProblem | "unreadable";

/** `expiresAt` is from GitHub's expiration header on the last bot response: null before the first, or for a token with no expiry. */
export type BotHealth = { state: "ok"; expiresAt: string | null } | { state: "absent" } | { state: "refused"; problem: BotTokenProblem };

/** Blocked carries no client: a bot step has nothing to fall back on, least of all the user login's identity. */
export type BotAccess = { state: "ok"; client: GitHubClient; login: string | undefined; lsRemote: BotLsRemote } | { state: "blocked"; reason: "absent" | "refused" };

export interface BotHandle {
  access(): BotAccess;
}

export interface BotIdentity extends BotHandle {
  /** For `/health.bot`; never holds the token. */
  health(): BotHealth;
  /** The token's SHA-256, for the A17 scan; set only when the token was read. */
  readonly fingerprint?: string;
  /** Handed only to the workflow runtime, so a step reaches the bot through `ctx.capability(BOT_CAPABILITY)` alone. */
  readonly capabilities: Readonly<Record<string, WorkflowCapability<BotHandle>>>;
  /** Every bot response's rate-limit headers, for the F11 peak lines; set only when the token was read, and never holds it. */
  readonly usage?: UsageMeter;
}

interface BotIdentityOptions {
  path?: string | undefined;
  login?: string | undefined;
  /** Runs the bot's `git ls-remote`; defaults to `execGit`. */
  git?: GitExec;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Where the 14-day expiry alarm's ops-alarm line goes. */
  log?: (line: string) => void;
  /** Fingerprints already alarmed; tests pass their own so one test's alarm cannot silence another's. */
  alarmed?: Set<string>;
}

/** Only handles this module made pass `isBotHandle`, so no other capability can pose as the bot. */
const HANDLES = new WeakSet<object>();
const UNREGISTERED: BotAccess = { state: "blocked", reason: "absent" };

/** What a bot step calls. A runtime built without serve's capabilities, as the CLI's are, gives blocked rather than a throw. */
export function botAccess(ctx: { capability(name: string): unknown }): BotAccess {
  let handle: unknown;
  try {
    handle = ctx.capability(BOT_CAPABILITY);
  } catch {
    return UNREGISTERED;
  }
  return isBotHandle(handle) ? handle.access() : UNREGISTERED;
}

function isBotHandle(value: unknown): value is BotHandle {
  return typeof value === "object" && value !== null && HANDLES.has(value);
}

function capabilitiesOf(handle: BotHandle, secrets: string[]): Record<string, WorkflowCapability<BotHandle>> {
  HANDLES.add(handle);
  return { [BOT_CAPABILITY]: { handle, secrets } };
}

type TokenRead = { state: "ok"; token: string } | Exclude<BotHealth, { state: "ok" }>;

/**
 * Read once at start, like the owner keys: the capability vault's secret list is fixed when the runtime is built, so a
 * rotated token would escape its redaction. A rotation therefore needs a restart. Nothing here throws, so serve starts.
 */
export function openBotIdentity(options: BotIdentityOptions = { path: BOT_TOKEN_PATH, login: BOT_LOGIN }): BotIdentity {
  const read = readToken(options.path);
  if (read.state !== "ok") return disabled(read);
  const fingerprint = tokenFingerprint(read.token);
  const expiry = botTokenExpiryWatch({ fingerprint, now: options.now, log: options.log, alarmed: options.alarmed });
  const usage = usageMeter();
  const fetch = observingFetch(options.fetch, (headers) => {
    expiry.observe(headers);
    usage.observe(headers);
  });
  // The reconciler's github-api pool owns every rate-limit wait, so Octokit's throttle must not sleep under it.
  const budget = rateBudget({ now: options.now });
  const client = octokitClient({ token: async () => read.token, reauthOn401: false, throttleId: BOT_THROTTLE_ID, budget, fetch, now: options.now, poolOwnsWaits: true });
  const ok: BotAccess = { state: "ok", client, login: options.login, lsRemote: botLsRemote(read.token, options.git) };
  const access = (): BotAccess => ok;
  return { access, health: () => ({ state: "ok", expiresAt: expiry.expiresAt() }), fingerprint, usage, capabilities: capabilitiesOf({ access }, [read.token]) };
}

function disabled(health: Exclude<BotHealth, { state: "ok" }>): BotIdentity {
  const blocked: BotAccess = { state: "blocked", reason: health.state };
  const access = (): BotAccess => blocked;
  return { access, health: () => health, capabilities: capabilitiesOf({ access }, []) };
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

/** A refused token file costs only the bot: serve starts, and /health names the problem. */
export function openServeBot(open: () => BotIdentity = openBotIdentity, log: Logger, stateDir: string): BotIdentity {
  const bot = open();
  const health = bot.health();
  if (health.state === "refused") log.warn({ problem: health.problem }, "bot token file refused; bot steps are blocked");
  publishOrWarn(stateDir, health.state === "ok" ? bot.fingerprint : undefined, log);
  return bot;
}

/** A state dir serve cannot write costs only the scan, which then says "no fingerprint" rather than clean. */
function publishOrWarn(stateDir: string, fingerprint: string | undefined, log: Logger): void {
  try {
    publishFingerprint(stateDir, fingerprint);
  } catch (error) {
    log.warn({ err: error instanceof Error ? error.message : String(error) }, "bot token fingerprint not written; bot-token scan cannot run");
  }
}

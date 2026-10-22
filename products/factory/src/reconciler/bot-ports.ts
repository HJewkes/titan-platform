import { GitHubRequestError, githubApiPool, type GitHubClient, type PoolClock, type RateLimitProbeAnswer } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import type { BotAccess } from "../bot-identity.js";
import { configPath, readConfig } from "../config.js";
import { sqlitePoolStateStore } from "../github-api/pool-state.js";
import { botTransport } from "./bot-transport.js";
import { reconcilerConfig, type ReconcilerConfig } from "./config.js";
import { createObserve } from "./observe.js";
import type { BackstopAnswer, BackstopCall, BotPorts, Observe } from "./service.js";

/** The bot's rows in the pool-state table; the user login's pool, if one is ever built, keys its own. */
export const BOT_POOL_IDENTITY = "github-bot";

interface BotPortsOptions {
  /** The bot identity's client only (I13): nothing here can fall back on the user login's. */
  client: GitHubClient;
  login: string;
  db: Db;
  clock: PoolClock;
  lsRemote: BotPorts["lsRemote"];
  observe: Observe;
}

/** The production `BotPorts`: the bot's client behind a durable `github-api` pool, with S2's conditional gates on. */
export function buildBotPorts({ client, login, db, clock, lsRemote, observe }: BotPortsOptions): BotPorts {
  const poolState = sqlitePoolStateStore(db, clock.now);
  const pool = githubApiPool<BackstopCall, BackstopAnswer>({ identity: BOT_POOL_IDENTITY, send: botTransport(client), clock, state: poolState, probe: () => probeRateLimit(client) });
  return { identity: BOT_POOL_IDENTITY, login, pool, poolState, conditionalGates: true, lsRemote, observe };
}

/** `GET /rate_limit` costs no point; a failure without an HTTP status is a network failure, which re-arms the probe. */
async function probeRateLimit(client: GitHubClient): Promise<RateLimitProbeAnswer> {
  try {
    const response = await client.request("GET /rate_limit");
    return { status: response.status, body: response.data };
  } catch (error) {
    if (error instanceof GitHubRequestError) return { status: error.status };
    return { networkError: true };
  }
}

/** The bot's access once serve has checked it is open and names a login. */
export type ServeBot = Omit<Extract<BotAccess, { state: "ok" }>, "login"> & { login: string };

/** What serve starts the reconciler from: the config, and ports it builds over the bot's own access only (I13). */
export interface ServeReconciler {
  config: ReconcilerConfig;
  ports(bot: ServeBot, db: Db): BotPorts;
}

/** The pool sleeps out a closed pair's reset; an unref'd timer never holds a stopping serve open. */
const WALL_CLOCK: PoolClock = { now: Date.now, sleep: (ms) => new Promise<void>((wake) => void setTimeout(wake, ms).unref()) };

/** Serve's production reconciler: the config file's `reconciler` block, over the bot identity serve opened, and no other client. */
export function serveReconciler(env: NodeJS.ProcessEnv): ServeReconciler {
  const config = reconcilerConfig(readConfig(configPath(env)) ?? {});
  return {
    config,
    ports: (bot, db) => buildBotPorts({ client: bot.client, login: bot.login, db, clock: WALL_CLOCK, lsRemote: bot.lsRemote, observe: createObserve({ now: Date.now }) }),
  };
}

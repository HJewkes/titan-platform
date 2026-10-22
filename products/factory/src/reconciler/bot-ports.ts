import { GitHubRequestError, githubApiPool, type GitHubClient, type PoolClock, type RateLimitProbeAnswer } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { sqlitePoolStateStore } from "../github-api/pool-state.js";
import { botTransport } from "./bot-transport.js";
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

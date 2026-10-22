import type { Logger } from "@titan-design/daemon";
import type { Db } from "@titan-design/store-sqlite";
import type { BotAccess } from "./bot-identity.js";
import type { PassStamp, SourcesReader } from "./github-sources/mode.js";
import type { ServeBot, ServeReconciler } from "./reconciler/bot-ports.js";
import { startReconcilerSweep } from "./reconciler/service.js";
import type { Sweep } from "./sweep.js";

/** `health.sources.reconciler`: `no-bot` is an enabled reconciler serve would not start, because the bot cannot run it. */
export type ReconcilerHealth = "running" | "disabled" | "no-bot";

interface ServeReconcilerContext {
  sources: SourcesReader;
  db: Db;
  log: Logger;
  now?: () => number;
  stamp: PassStamp;
}

/**
 * I13: the reconciler runs as the bot or not at all. A blocked bot, or one with no login for C7 to match, starts nothing:
 * there is no client to fall back on, and serve never hands the reconciler the user login's.
 */
export function startServeReconciler(reconciler: ServeReconciler | undefined, access: BotAccess, context: ServeReconcilerContext): { sweep?: Sweep; health: ReconcilerHealth } {
  if (!reconciler?.config.enabled) return { health: "disabled" };
  const bot = runnableBot(access);
  if (typeof bot === "string") {
    context.log.warn({ reason: bot }, "reconciler.no-bot");
    return { health: "no-bot" };
  }
  const sweep = startReconcilerSweep({ config: reconciler.config, bot: reconciler.ports(bot, context.db) }, context.sources, context.db, context.log, context.now, context.stamp);
  return { sweep, health: "running" };
}

function runnableBot(access: BotAccess): ServeBot | "absent" | "refused" | "no-login" {
  if (access.state !== "ok") return access.reason;
  if (access.login === undefined) return "no-login";
  return { ...access, login: access.login };
}

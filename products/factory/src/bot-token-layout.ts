import { join } from "node:path";

/** Where the bot's token sits under a home dir: its own 0700 dir, outside every worktree (TP-3094 option B). */
export function botTokenPathIn(home: string): string {
  return join(home, ".config", "titan-factory", "secrets", "github-bot.token");
}

import { userInfo } from "node:os";
import { botTokenPathIn } from "./bot-token-layout.js";

/** The passwd entry's home, not `$HOME`, so no environment variable can move the path; undefined when the uid has none. */
function passwdHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

function botTokenPathFor(home: string | undefined): string | undefined {
  return home === undefined ? undefined : botTokenPathIn(home);
}

/**
 * The bot's token file. Fixed in code like `OWNER_KEYS_DIR`: no environment variable, flag or config can point serve
 * elsewhere. Undefined only for a uid with no home, and then serve looks nowhere. Its own module so the forked serve
 * child in tests can swap it out (`test-support/serve-child-main.ts`).
 */
export const BOT_TOKEN_PATH: string | undefined = botTokenPathFor(passwdHome());

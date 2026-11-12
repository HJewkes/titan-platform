import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@titan-design/rpc-protocol/narrow";

/** A file's text, or undefined when it cannot be read. Injected so tests never touch a real login. */
export type ReadText = (file: string) => string | undefined;

const readFile: ReadText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

// The email is ignored because it can change; the account and organization ids do not.
function identityIn(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const account: unknown = isRecord(parsed) ? parsed.oauthAccount : undefined;
    const user = isRecord(account) ? account.accountUuid : undefined;
    const org = isRecord(account) ? account.organizationUuid : undefined;
    return nonEmpty(user) && nonEmpty(org) ? `${user}/${org}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * CC-1289: the Anthropic login a config dir bills, `accountUuid/organizationUuid`, or undefined
 * when none can be read. Claude Code keeps the default dir's login in `~/.claude.json` when
 * CLAUDE_CONFIG_DIR is unset, so that file is read first and `<dir>/.claude.json` second.
 */
export function accountIdentity(configDir: string, home: string = os.homedir(), read: ReadText = readFile): string | undefined {
  const own = path.join(configDir, ".claude.json");
  const isDefault = path.resolve(configDir) === path.resolve(home, ".claude");
  const files = isDefault ? [path.join(home, ".claude.json"), own] : [own];
  for (const file of files) {
    const identity = identityIn(read(file));
    if (identity !== undefined) return identity;
  }
  return undefined;
}

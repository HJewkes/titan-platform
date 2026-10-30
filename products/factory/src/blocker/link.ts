import { execSafeAsync, type SafeExecResult } from "@titan-design/agent-dispatch";
import { configPath, loadConfig } from "../config.js";

/** `titan-console inbox link` reads config alone, never the daemon, so a short bound is plenty. */
const LINK_TIMEOUT_MS = 10_000;
const URL_LINE = /^https?:\/\/\S+$/;

export type LinkExec = (argv: readonly string[]) => Promise<SafeExecResult>;
/** The console URL that opens the inbox on `id`, or undefined when the console cannot say. */
export type InboxLink = (env: NodeJS.ProcessEnv, id: string) => Promise<string | undefined>;

/** Runs `<titan-console> inbox link <id>` and keeps its one URL line; any failure reads as no link. */
export async function inboxLinkVia(prefix: readonly string[] | undefined, id: string, exec: LinkExec): Promise<string | undefined> {
  if (prefix === undefined || prefix.length === 0) return undefined;
  try {
    const { status, stdout } = await exec([...prefix, "inbox", "link", id]);
    const line = stdout.trim();
    return status === 0 && URL_LINE.test(line) ? line : undefined;
  } catch {
    return undefined;
  }
}

function systemLinkExec(env: NodeJS.ProcessEnv): LinkExec {
  const vars = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return ([bin, ...args]) => execSafeAsync(bin!, args, vars, LINK_TIMEOUT_MS);
}

/** The same titan-console argv prefix visual delivery runs (`shepherd.visualDelivery.console`), never a PATH lookup. */
export const configuredInboxLink: InboxLink = async (env, id) => {
  let prefix: readonly string[] | undefined;
  try {
    prefix = loadConfig(configPath(env)).shepherd?.visualDelivery?.console;
  } catch {
    return undefined;
  }
  return inboxLinkVia(prefix, id, systemLinkExec(env));
};

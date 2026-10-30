import { DispatchError } from "@titan-design/agent-dispatch";

/** The code agent-chat refuses a spawn with when the account it would bill is at its five_hour ceiling (CC-1078). */
const ACCOUNT_LIMIT_CODE = "reviewer_account_limit";

const CODE_TRAILER = /\n\s*code: (\S+) retryable: (?:true|false)$/;
const MAX_CAUSE_DEPTH = 4;

/** The refusal itself only for the broker's coded account-limit refusal, found on the error or a cause it wraps; a pool, name or load refusal is not one. */
export function accountLimitRefusal(error: unknown): DispatchError | undefined {
  let at = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && at instanceof Error; depth++, at = at.cause) {
    if (at instanceof DispatchError && CODE_TRAILER.exec(at.message.trim())?.[1] === ACCOUNT_LIMIT_CODE) return at;
  }
  return undefined;
}

/** How a log line names an account; agent-chat's default one is spawned under no config directory. */
const accountName = (configDir: string | undefined): string => configDir ?? "the default account";

/**
 * Spawns under each account in turn, the first preferred: only an account-limit refusal moves the spawn to the next one, once
 * per account. Any other failure, and the last account's refusal, is thrown as it came. Logs which account a fallback used.
 */
export async function spawnOnAccounts<D extends string | undefined>(name: string, accounts: readonly D[], spawn: (configDir: D) => Promise<void>): Promise<void> {
  for (const [index, configDir] of accounts.entries()) {
    try {
      await spawn(configDir);
      if (index > 0) console.warn(`shepherd: ${name} spawned on the fallback account ${accountName(configDir)}`);
      return;
    } catch (error) {
      if (index === accounts.length - 1 || accountLimitRefusal(error) === undefined) throw error;
      console.warn(`shepherd: ${name}'s spawn was refused at the account limit on ${accountName(configDir)}; trying ${accountName(accounts[index + 1])}`);
    }
  }
}

/** The accounts from `first` on, in rotation order; one the rotation no longer lists is tried alone. */
export function accountsFrom<D>(rotation: readonly D[], first: D): readonly D[] {
  const at = rotation.indexOf(first);
  return at < 0 ? [first] : rotation.slice(at);
}

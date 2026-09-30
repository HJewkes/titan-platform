import type { ClassifiedAction, GuardedAction } from "./types.js";

export type FamilyName = "secret" | "config" | "merge" | "release" | "egress";

interface SpellingRow {
  family: FamilyName;
  action: GuardedAction;
  remedy: string;
}

const SECRET =
  "Credential files and the keychain are owner-only. Ask the owner for the value, or run the tool that uses the credential without reading it.";
const CONFIG =
  "Permission settings, hooks and home CLAUDE.md files are edited by the owner only. Describe the change and ask the owner to make it.";

const secret = (): SpellingRow => ({ family: "secret", action: "secret-read", remedy: SECRET });
const config = (): SpellingRow => ({ family: "config", action: "authority-config", remedy: CONFIG });

/** Every spelling the classifier emits, keyed by id. A family adds its rows here and its handler to `classify.ts`. */
export const SPELLINGS = {
  "read.secret": secret(),
  "read.secret-symlink": secret(),
  "grep.secret": secret(),
  "bash.secret.cat": secret(),
  "bash.secret.head-tail-less": secret(),
  "bash.secret.grep": secret(),
  "bash.secret.cp-mv": secret(),
  "bash.secret.encode": secret(),
  "bash.secret.redirect-in": secret(),
  "bash.secret.here-string": secret(),
  "bash.secret.symlink": secret(),
  "bash.secret.link-then-read": secret(),
  "bash.secret.var-indirection": secret(),
  "bash.secret.glob": secret(),
  "bash.secret.inline-interpreter": secret(),
  "bash.secret.script-by-path": secret(),
  "bash.secret.keychain": secret(),
  "bash.secret.mention": secret(),
  "write.config": config(),
  "bash.config.redirect-out": config(),
  "bash.config.tee": config(),
  "bash.config.cp-mv-ln": config(),
  "bash.config.in-place": config(),
  "bash.config.remove": config(),
  "bash.config.interpreter": config(),
  "bash.config.git-hooks": config(),
  "bash.config.git-config-hookspath": config(),
  "bash.config.claude-cli": config(),
  "bash.config.mention": config(),
} as const satisfies Record<string, SpellingRow>;

export type SpellingId = keyof typeof SPELLINGS;

export function classified(spelling: SpellingId, subject: Record<string, string>): ClassifiedAction {
  const row: SpellingRow = SPELLINGS[spelling];
  return { action: row.action, spelling, subject, remedy: row.remedy };
}

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
const MERGE =
  "Merging into a protected branch is resolved by the owner or the reviewed merge path. Push your branch, open a pull request and report it.";
const RELEASE =
  "Publishing, releasing and deploying go through the release workflow the owner approves. Stop and report what is ready to ship.";
const EGRESS =
  "Sending data to a host off the allowlist is owner-only. Keep the data local and ask the owner to send it.";

const secret = (): SpellingRow => ({ family: "secret", action: "secret-read", remedy: SECRET });
const config = (): SpellingRow => ({ family: "config", action: "authority-config", remedy: CONFIG });
const merge = (): SpellingRow => ({ family: "merge", action: "merge", remedy: MERGE });
const release = (): SpellingRow => ({ family: "release", action: "release", remedy: RELEASE });
const egress = (): SpellingRow => ({ family: "egress", action: "private-egress", remedy: EGRESS });

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
  "bash.merge.gh-pr-merge": merge(),
  "bash.merge.gh-api-merge": merge(),
  "bash.merge.gh-api-merges": merge(),
  "bash.merge.gh-api-graphql": merge(),
  "bash.merge.curl-api": merge(),
  "bash.merge.git-merge-protected": merge(),
  "bash.merge.git-push-protected": merge(),
  "bash.merge.git-push-implicit": merge(),
  "bash.merge.git-push-all": merge(),
  "bash.release.npm-publish": release(),
  "bash.release.pnpm-publish": release(),
  "bash.release.yarn-bun-publish": release(),
  "bash.release.changeset-publish": release(),
  "bash.release.npm-registry-mutation": release(),
  "bash.release.gh-release": release(),
  "bash.release.gh-workflow-run": release(),
  "bash.release.wrangler-deploy": release(),
  "bash.release.version-packages-merge": release(),
  "bash.egress.gh-gist": egress(),
  "bash.egress.curl-upload": egress(),
  "bash.egress.wget-upload": egress(),
  "bash.egress.httpie": egress(),
  "bash.egress.raw-socket": egress(),
  "bash.egress.remote-copy": egress(),
  "bash.egress.cloud-copy": egress(),
  "bash.egress.git-push-url": egress(),
} as const satisfies Record<string, SpellingRow>;

export type SpellingId = keyof typeof SPELLINGS;

export function classified(spelling: SpellingId, subject: Record<string, string>): ClassifiedAction {
  const row: SpellingRow = SPELLINGS[spelling];
  return { action: row.action, spelling, subject, remedy: row.remedy };
}

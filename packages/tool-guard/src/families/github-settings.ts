import type { SimpleCommand } from "../shell/commands.js";
import { classified } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";
import { apiSettingsWrite } from "./api-rulesets.js";
import type { SettingsWrite } from "./api-rulesets.js";
import { ghApiRequest } from "./gh-api.js";
import { ghCommandLine } from "./gh-words.js";
import { httpRequest } from "./http-request.js";
import { set } from "./options.js";

/** Never the owner, repo or branch: the hard stop is the same whichever one it names. */
const subject = (write: SettingsWrite) => ({ pattern: `github:${write.route}`, scope: write.scope });

/** A gh endpoint known only at run time is not read here; TP-2707 d owns that reading. */
function ghSettings(cmd: SimpleCommand): ClassifiedAction[] {
  const line = ghCommandLine(cmd.args);
  if (line.hidden || line.path.join(" ") !== "api") return [];
  const request = ghApiRequest(line.leaf);
  const write = request.endpoint === null ? null : apiSettingsWrite(request.endpoint, request.method);
  return write ? [classified("bash.config.gh-api-ruleset", subject(write))] : [];
}

/** A run-time URL is already denied as `bash.merge.curl-api` when it may reach the GitHub API. */
function httpSettings(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  const request = httpRequest(cmd, ctx);
  if (!request) return [];
  const writes = request.urls.filter((u) => !u.dynamic).flatMap((u) => apiSettingsWrite(u.value, request.method) ?? []);
  return writes.slice(0, 1).map((write) => classified("bash.config.curl-api-ruleset", subject(write)));
}

/**
 * GitHub ruleset and branch-protection writes are authority configuration, the `ruleset-write` hard stop, not
 * merges: the merge family's rows would let automation through on a reviewer's MERGE verdict.
 */
export const githubSettings: Family = {
  names: set("gh", "curl", "wget", "http", "https"),
  bash: (cmd, ctx) => (cmd.name === "gh" ? ghSettings(cmd) : httpSettings(cmd, ctx)),
};

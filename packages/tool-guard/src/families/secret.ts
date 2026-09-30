import type { ReadEvent } from "../event.js";
import { commandMentions, pathMentions } from "../mentions.js";
import type { Mention } from "../mentions.js";
import { GUARDED_PATHS } from "../paths.js";
import type { SimpleCommand } from "../shell/commands.js";
import { classified } from "../spellings.js";
import type { SpellingId } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";

/** Commands that touch a credential file's metadata, never its contents. `ssh-add -l` names no file, so needs no entry. */
const METADATA = new Set(["ls", "stat", "test", "[", "[[", "chmod", "ssh", "git"]);
/** Commands that read every file under a directory argument. */
const WALKERS = new Set(["grep", "rg", "ag", "ack", "cp", "rsync", "tar", "zip"]);
/** Walkers whose last operand is where they write, so a directory there is not read. */
const COPIERS = new Set(["cp", "rsync"]);
const KEYCHAIN_FINDS = new Set(["find-generic-password", "find-internet-password"]);

const VERBS: Record<string, SpellingId> = {
  cat: "bash.secret.cat",
  ...each(["head", "tail", "less", "more", "bat"], "bash.secret.head-tail-less"),
  ...each(["grep", "rg", "ag", "ack"], "bash.secret.grep"),
  ...each(["cp", "mv", "rsync"], "bash.secret.cp-mv"),
  ...each(["base64", "xxd", "od", "strings", "openssl", "hexdump"], "bash.secret.encode"),
  ln: "bash.secret.link-then-read",
};

const BY_VIA: Partial<Record<Mention["via"], SpellingId>> = { symlink: "bash.secret.symlink", glob: "bash.secret.glob" };

const BY_SITE: Partial<Record<Mention["site"], SpellingId>> = {
  "redirect-in": "bash.secret.redirect-in",
  "here-string": "bash.secret.here-string",
  assignment: "bash.secret.var-indirection",
  inline: "bash.secret.inline-interpreter",
};

function each(names: string[], spelling: SpellingId): Record<string, SpellingId> {
  return Object.fromEntries(names.map((n) => [n, spelling]));
}

function bash(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  if (isKeychainRead(cmd)) return [classified("bash.secret.keychain", { pattern: "keychain" })];
  const walker = cmd.name !== null && WALKERS.has(cmd.name);
  const target = cmd.name !== null && COPIERS.has(cmd.name) ? cmd.args.filter((a) => !a.value.startsWith("-")).at(-1) : undefined;
  return commandMentions(cmd, ctx, GUARDED_PATHS.secret, walker)
    .filter((m) => !(m.site === "arg" && cmd.name !== null && METADATA.has(cmd.name)))
    .filter((m) => !(m.via === "contains" && m.word === target))
    .map((m) => classified(spellingOf(cmd, m), { pattern: m.id }));
}

function spellingOf(cmd: SimpleCommand, m: Mention): SpellingId {
  const verb = cmd.name !== null && Object.hasOwn(VERBS, cmd.name) ? VERBS[cmd.name] : undefined;
  return BY_VIA[m.via] ?? BY_SITE[m.site] ?? verb ?? "bash.secret.mention";
}

function isKeychainRead(cmd: SimpleCommand): boolean {
  if (cmd.name !== "security") return false;
  const [sub, ...rest] = cmd.args.map((a) => a.value);
  if (sub === "dump-keychain") return true;
  return sub !== undefined && KEYCHAIN_FINDS.has(sub) && rest.some((v) => /^-[a-zA-Z]*[wg]/.test(v));
}

function read(event: ReadEvent, ctx: ClassifyContext): ClassifiedAction[] {
  const grep = event.toolName === "Grep";
  return pathMentions(event.path, event.cwd, ctx, GUARDED_PATHS.secret, grep).map((m) => {
    const spelling = grep ? "grep.secret" : m.via === "symlink" ? "read.secret-symlink" : "read.secret";
    return classified(spelling, { pattern: m.id });
  });
}

/** Reading a credential: SEC rows of the authority table. */
export const secret: Family = { bash, read };

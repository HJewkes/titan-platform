import type { ReadEvent } from "../event.js";
import { commandMentions, pathMentions } from "../mentions.js";
import type { Mention } from "../mentions.js";
import { GUARDED_PATHS } from "../paths.js";
import { caseFoldedArgs } from "../shell/case-attrs.js";
import type { SimpleCommand, Wrapping } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { classified } from "../spellings.js";
import type { SpellingId } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";
import { copyDestination } from "./copy-destination.js";

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

const BY_WRAPPING: Partial<Record<Wrapping, SpellingId>> = {
  subshell: "bash.secret.subshell",
  "sh-c": "bash.secret.sh-c",
  eval: "bash.secret.sh-c",
  xargs: "bash.secret.xargs",
  "heredoc-shell": "bash.secret.heredoc-shell",
  "piped-shell": "bash.secret.heredoc-shell",
};

const HOME_REF_RE = /^\$(HOME|\{HOME\})(\/|$)/;

function each(names: string[], spelling: SpellingId): Record<string, SpellingId> {
  return Object.fromEntries(names.map((n) => [n, spelling]));
}

/** An argument a case attribute may have changed is read as written and in each case bash may have mapped it to. */
function bash(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  if (isKeychainRead(cmd)) return [classified("bash.secret.keychain", { pattern: "keychain" })];
  const actions = caseFoldedArgs(cmd.args).flatMap((args) => mentionActions({ ...cmd, args }, ctx));
  const keys = actions.map((a) => JSON.stringify(a));
  return actions.filter((_, i) => keys.indexOf(keys[i] as string) === i);
}

function mentionActions(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  const walker = cmd.name !== null && WALKERS.has(cmd.name);
  const target = cmd.name !== null && COPIERS.has(cmd.name) ? copyDestination(cmd) : null;
  return commandMentions(cmd, ctx, GUARDED_PATHS.secret, walker)
    .filter((m) => !(m.site === "arg" && cmd.name !== null && METADATA.has(cmd.name)))
    .filter((m) => !(m.via === "contains" && m.word === target))
    .map((m) => classified(spellingOf(cmd, m, ctx.home), { pattern: m.id }));
}

/** The most specific spelling: how the path matched, where it sat, how the command was reached, how the word was typed, the verb. */
function spellingOf(cmd: SimpleCommand, m: Mention, home: string): SpellingId {
  const verb = cmd.name !== null && Object.hasOwn(VERBS, cmd.name) ? VERBS[cmd.name] : undefined;
  const wrapped = cmd.wrapping.map((w) => BY_WRAPPING[w]).find((id) => id !== undefined);
  const typed = m.via === "path" && m.word ? wordSpelling(m.word, cmd.dir, home) : undefined;
  return BY_VIA[m.via] ?? BY_SITE[m.site] ?? wrapped ?? typed ?? verb ?? "bash.secret.mention";
}

/** A path typed other than as `~/...`: split by quotes, through a variable, absolute, or relative to the home directory. */
function wordSpelling(word: WordToken, dir: string | null, home: string): SpellingId | undefined {
  if (word.spliced) return "bash.secret.quoting";
  if (word.typed !== undefined) return HOME_REF_RE.test(word.typed) ? "bash.secret.home-relative" : "bash.secret.var-indirection";
  if (word.value.startsWith("/")) return "bash.secret.absolute";
  return !word.value.startsWith("~") && dir === home ? "bash.secret.home-relative" : undefined;
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
const SECRET_VERBS = new Set([...METADATA, ...WALKERS, ...Object.keys(VERBS), "security"]);

export const secret: Family = { verbs: SECRET_VERBS, bash, read };

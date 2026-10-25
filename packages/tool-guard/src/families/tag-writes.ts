import type { SimpleCommand } from "../shell/commands.js";
import { isCaseUnsure } from "../shell/case-attrs.js";
import { parseGit } from "../shell/git.js";
import type { GitInvocation } from "../shell/git.js";
import type { WordToken } from "../shell/lexer.js";
import type { ClassifyContext, LineTags } from "../types.js";
import { GIT_TAG_LONG, resolveLong } from "./long-options.js";
import { hasFlag, readOptions, set } from "./options.js";

const GIT_TAG_VALUES = set("-m", "-F", "-u", ...GIT_TAG_LONG.values);
const resolveTagLong = resolveLong(GIT_TAG_LONG, false);
/** Options that put `git tag` in list or verify mode, where its words are patterns or names it only reads. */
const READS_TAGS = ["-l", "--list", "-v", "--verify", "-n", "--contains", "--no-contains", "--with", "--without", "--points-at", "--merged", "--no-merged"];
const TAG_REF_RE = /^(?:refs\/)?tags\//;

const unsure = (word: WordToken) => word.dynamic || isCaseUnsure(word);

/** The tags `git tag` creates, moves or deletes; `"any"` when a name is known only at run time. */
function tagCommandWrites(inv: GitInvocation): LineTags | null {
  const options = readOptions(inv.subArgs, GIT_TAG_VALUES, resolveTagLong);
  if (options.positionals.length === 0 || hasFlag(options, ...READS_TAGS)) return null;
  const names = hasFlag(options, "-d", "--delete") ? options.positionals : options.positionals.slice(0, 1);
  return names.some(unsure) ? "any" : new Set(names.map((w) => w.value));
}

/** The tag `git update-ref` writes or deletes; `--stdin` reads its refs from input, so it may write any. */
function updateRefWrites(inv: GitInvocation): LineTags | null {
  const options = readOptions(inv.subArgs, set("-m"));
  const ref = options.positionals[0];
  if (hasFlag(options, "--stdin") || (ref !== undefined && unsure(ref))) return "any";
  return ref !== undefined && TAG_REF_RE.test(ref.value) ? new Set([ref.value.replace(TAG_REF_RE, "")]) : null;
}

/** The tags a command writes, in any repository: a later push reads each as a tag whatever the disk holds now. */
function tagWrites(cmd: SimpleCommand, ctx: ClassifyContext): LineTags | null {
  if (cmd.name !== "git") return null;
  const inv = parseGit(cmd.args, cmd.dir, ctx.home);
  if (inv.subDynamic) return "any";
  if (inv.sub === "tag") return tagCommandWrites(inv);
  return inv.sub === "update-ref" ? updateRefWrites(inv) : null;
}

const union = (a: LineTags | undefined, b: LineTags): LineTags => (a === "any" || b === "any" ? "any" : new Set([...(a ?? []), ...b]));

/** Adds tags to the context and to every fallback it holds, so a chain that ends does not drop them. */
function withTags(ctx: ClassifyContext, tags: LineTags): ClassifyContext {
  const chainTrust = ctx.chainTrust && { ...ctx.chainTrust, fallback: withTags(ctx.chainTrust.fallback, tags) };
  return { ...ctx, lineTags: union(ctx.lineTags, tags), ...(chainTrust ? { chainTrust } : {}) };
}

/** The context later commands see once `cmd` has written tags; undefined when it writes none. */
export function afterTagWrites(cmd: SimpleCommand, ctx: ClassifyContext): ClassifyContext | undefined {
  const tags = tagWrites(cmd, ctx);
  return tags === null ? undefined : withTags(ctx, tags);
}

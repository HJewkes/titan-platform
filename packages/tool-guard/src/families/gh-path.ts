import { isCaseUnsure } from "../shell/case-attrs.js";
import type { WordToken } from "../shell/lexer.js";
import { set } from "./options.js";

/**
 * The gh groups whose verb a family reads: `pr` (`ghPrMerge`, the `pr checkout` branch of `switchDir`), `release`
 * and `workflow` (the release family's `gh` rule) and `gist` (egress `gist`). Any other group is a complete path
 * on its own; a family that starts reading a new group's verb must add the group here.
 */
const VERB_GROUPS = set("pr", "release", "workflow", "gist");
/** gh options that take the next word as their value and may sit before the group. */
const VALUE_OPTS = set("-R", "--repo", "--hostname");
/** Flags every gh level defines as taking no value, so they never take the next word. */
const NO_VALUE_FLAGS = set("-h", "--help");
/** Words cobra drops while finding the command, so they may fill no path slot. */
const DROPPED = set("", "-");

/** An unquoted dynamic word word-splits, so it can carry several path words; the test `shell/git.ts` uses. */
const splits = (word: WordToken | undefined) => Boolean(word?.dynamic && (!word.quoted || word.unquotedExpansion));

/** A known value with a blank that an unquoted expansion would split in bash, though not in zsh. */
const splitsKnown = (word: WordToken | undefined) => Boolean(word?.unquotedExpansion && word.typed !== undefined && /\s/.test(word.value));

/** No gh command name holds a blank, so a path word with one is treated like an unknown one. */
const unknown = (word: WordToken) => word.dynamic || isCaseUnsure(word) || /\s/.test(word.value);

function pathComplete(path: WordToken[]): boolean {
  const [group] = path;
  return path.length >= 2 || (group !== undefined && !VERB_GROUPS.has(group.value));
}

/** One way gh may have read the words before `at`: the path words so far and whether a `--` ended the options. */
interface Reading {
  at: number;
  path: WordToken[];
  afterDashes: boolean;
}

/**
 * Whether the words that pick what gh does, the group and for a group in `VERB_GROUPS` its verb, are only known
 * at run time under any reading of the options before them: an unknown word in a path slot, an unknown option
 * word, or an option value that may split.
 */
export function ghPathUnknown(args: WordToken[]): boolean {
  const seen = new Set<string>();
  const pending: Reading[] = [{ at: 0, path: [], afterDashes: false }];
  for (let reading = pending.pop(); reading; reading = pending.pop()) {
    const key = `${reading.at}|${reading.afterDashes}|${JSON.stringify(reading.path.map((w) => w.value))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const next = step(args, reading);
    if (next === null) return true;
    pending.push(...next);
  }
  return false;
}

/** The readings after the word at `reading.at`, none once the path is complete, null when a path slot is unknown. */
function step(args: WordToken[], reading: Reading): Reading[] | null {
  const { at, path, afterDashes } = reading;
  const word = args[at];
  if (word === undefined || pathComplete(path)) return [];
  if (afterDashes || !optionShaped(word)) {
    if (unknown(word)) return null;
    const asPath = { at: at + 1, path: [...path, word], afterDashes };
    return DROPPED.has(word.value) ? [asPath, { at: at + 1, path, afterDashes }] : [asPath];
  }
  if (word.value === "--" && !unknown(word)) return [{ at: at + 1, path, afterDashes: true }];
  const widths = optionWidths(word, args[at + 1]);
  return widths && widths.map((width) => ({ at: at + width, path, afterDashes }));
}

/** A word gh may read as an option; an unknown word not written with a leading `-` is read as a path word. */
const optionShaped = (word: WordToken) => word.value.length > 1 && word.value.startsWith("-");

/**
 * The words an option may span, or null when that or what it leaves for the path is unknown. Cobra lets a `--x`
 * or `-x` a level does not define as a no-value flag take the next word, which level defines it depends on the
 * path, and pflag may still read a longer cluster's last letter as taking one, so any other option without an
 * attached value may span one word or two.
 */
function optionWidths(word: WordToken, next: WordToken | undefined): number[] | null {
  const valueAt = attachedValueAt(word.value);
  if (word.dynamic || isCaseUnsure(word) || splitsKnown(word)) return valueAt !== null && valueAt <= firstDynamic(word) && !splits(word) ? [1] : null;
  if (valueAt !== null || NO_VALUE_FLAGS.has(word.value)) return [1];
  if (splits(next) || splitsKnown(next)) return null;
  return VALUE_OPTS.has(word.value) ? [2] : [1, 2];
}

/** Where an option's own value starts inside its word (`--repo=x`, `-Rx`), null when it has none there. */
function attachedValueAt(v: string): number | null {
  if (v.startsWith("--")) {
    const eq = v.indexOf("=");
    return eq > 0 ? eq + 1 : null;
  }
  const letter = [...v.slice(1)].findIndex((c) => VALUE_OPTS.has(`-${c}`));
  return letter >= 0 && letter + 2 < v.length ? letter + 2 : null;
}

/** The first index of `value` whose text is only known at run time; 0 when that cannot be placed. */
function firstDynamic(word: WordToken): number {
  if (!word.dynamic) return 0;
  const at = [...word.refs.map((r) => r.start), ...(word.cuts ?? []).map((c) => c.at)];
  return at.length > 0 ? Math.min(...at) : 0;
}

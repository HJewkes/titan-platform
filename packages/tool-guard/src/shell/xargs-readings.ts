import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";
import { batches, inputReadings, inputRecords, lineRuns, logicalLines } from "./xargs-input.js";
import { insertRuns, literalWord } from "./xargs-insert.js";
import { quotedReadings } from "./xargs-quotes.js";

const WORST_CASE: Record<string, string[]> = { git: ["push", "origin", "HEAD:main"], gh: ["pr", "merge", "1"] };

/** More added runs than this are replaced by the worst case, so a long input cannot hold the hook past its timeout. */
export const MAX_ADDED_RUNS = 256;

/**
 * The argument lists `xargs` runs the command with. `main` reads options and input as the guard always has. `added` holds the
 * readings beside it: getopt's replace string where it differs, the `-J` splice and input quoting. The caller drops an added run
 * whose script cannot parse, so these readings never turn a parsed line into an unparsed one.
 */
interface XargsRuns {
  main: WordToken[][];
  added: WordToken[][];
}

/** Per command, the runs of each kind; computed once, as `xargsCommands` asks for main and added runs in turn. */
export function runReadings(stdin: string | null, isShell: (name: string | null) => boolean) {
  const memo = new Map<WordToken[], XargsRuns>();
  const of = (cmd: Unwrapped) => memo.get(cmd.args) ?? (memo.set(cmd.args, xargsRuns(cmd, stdin, isShell(cmd.name))).get(cmd.args) as XargsRuns);
  return { main: (cmd: Unwrapped) => of(cmd).main, added: (cmd: Unwrapped) => of(cmd).added };
}

function xargsRuns(cmd: Unwrapped, stdin: string | null, shell: boolean): XargsRuns {
  if (!cmd.xargs) return { main: [cmd.args], added: [] };
  const { replace, replaceAsOption, insert, delimiters, batch } = cmd.xargs;
  if (stdin === null) return { main: unknownRuns(cmd, replaceAsOption), added: failClosed(cmd) };
  const plainGroups = once(() => inputReadings(stdin, delimiters).flatMap((lines) => batches(stdin, lines, batch)));
  const quoted = once(() => (delimiters?.length === 0 ? quotedReadings(logicalLines(stdin)).flatMap((lines) => batches(stdin, lines, batch)) : []));
  const allGroups = () => [...plainGroups(), ...quoted()];
  const reading = (r: string | null, groups: () => string[][]) =>
    r !== null ? inputRecords(stdin, delimiters).flatMap((line) => lineRuns(cmd.args, r, line, !shell)) : shell ? [cmd.args] : appended(cmd.args, groups());
  const main = reading(replaceAsOption, plainGroups);
  const added = [
    ...(replace !== replaceAsOption ? reading(replace, allGroups) : replace === null && !shell ? appended(cmd.args, quoted()) : []),
    ...(insert === null ? [] : insertRuns(cmd.args, insert, allGroups())),
  ];
  return { main, added: added.length > MAX_ADDED_RUNS ? failClosed(cmd) : added };
}

function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}

function appended(args: WordToken[], groups: string[][]): WordToken[][] {
  return groups.map((words) => [...args, ...words.map(literalWord)]);
}

/** Added readings that cannot be read, or are too many to read, as the worst case of each: the getopt replace string and the `-J` splice. */
function failClosed(cmd: Unwrapped): WordToken[][] {
  const { replace, replaceAsOption, insert } = cmd.xargs as NonNullable<Unwrapped["xargs"]>;
  const worst = WORST_CASE[cmd.name ?? ""];
  const replaced = replace !== replaceAsOption ? unknownRuns(cmd, replace) : replace === null ? unknownRuns(cmd, null) : [];
  return [...replaced, ...(worst ? insertRuns(cmd.args, insert, [worst]) : [])];
}

/** Input that cannot be read: a protected utility is also read with its worst case, as the replace string or as appended words, so it fails closed. */
function unknownRuns(cmd: Unwrapped, replace: string | null): WordToken[][] {
  const worst = WORST_CASE[cmd.name ?? ""];
  if (!worst) return [cmd.args];
  if (replace === null) return [cmd.args, [...cmd.args, ...worst.map(literalWord)]];
  if (cmd.args[0]?.value !== replace) return [cmd.args];
  return [cmd.args, [...worst.map(literalWord), ...cmd.args.slice(1)]];
}

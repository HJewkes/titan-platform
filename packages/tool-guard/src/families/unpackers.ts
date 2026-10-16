import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { mayBeOption } from "./http-request.js";

/** GNU tar and bsdtar short options that take a value: the rest of their cluster, or the next word. */
const TAR_VALUES = "bCfFgHIKLNTVX";
const TAR_LONG_VALUES = new Set(["--file", "--directory"]);
/** `--extract` or `--get`, which getopt_long also takes as any unambiguous prefix (`--ext`, `--ge`). */
const EXTRACT_LONG_RE = /^--(?:ext|ge)/;
const OLD_STYLE_RE = /^[A-Za-z]+$/;

/** Archive extractors, by command name, each with the test for its extract mode. */
const UNPACKERS = new Map<string, (args: WordToken[]) => boolean>([
  ["tar", tarExtracts],
  ["gtar", tarExtracts],
  ["bsdtar", tarExtracts],
  ["cpio", (args) => clusterHas(args, "i") || args.some((a) => EXTRACT_LONG_RE.test(a.value))],
  ["bsdcpio", (args) => clusterHas(args, "i") || args.some((a) => EXTRACT_LONG_RE.test(a.value))],
  ["pax", (args) => clusterHas(args, "r")],
  ["unzip", () => true],
  ["7z", sevenZipExtracts],
  ["7za", sevenZipExtracts],
  ["7zr", sevenZipExtracts],
  ["ar", (args) => modeHas(args[0], "x")],
  ["jar", (args) => modeHas(args[0], "x") || args.some((a) => EXTRACT_LONG_RE.test(a.value))],
]);

/**
 * Whether the command extracts an archive. It then writes whatever member paths the archive names, absolute ones
 * (`tar -P`, plain `cpio -i`) included, so no operand or working directory bounds what it writes.
 */
export function unpacks(cmd: SimpleCommand): boolean {
  return cmd.name !== null && (UNPACKERS.get(cmd.name)?.(cmd.args) ?? false);
}

/** An old-style first word (`xvf`) holds the mode, and each value letter in it takes one following word. */
function tarExtracts(args: WordToken[]): boolean {
  const first = args[0];
  if (first === undefined || first.dynamic || !OLD_STYLE_RE.test(first.value)) return tarOptionsExtract(args);
  if (first.value.includes("x")) return true;
  const taken = [...first.value].filter((c) => TAR_VALUES.includes(c)).length;
  return tarOptionsExtract(args.slice(1 + taken));
}

/** A run-time word that may be an option may be `-x`; a value or a word after `--` is no option. */
function tarOptionsExtract(args: WordToken[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) break;
    if (word.dynamic) {
      if (mayBeOption(word)) return true;
    } else if (word.value === "--") return false;
    else if (EXTRACT_LONG_RE.test(word.value)) return true;
    else if (TAR_LONG_VALUES.has(word.value)) i++;
    else if (/^-[^-]/.test(word.value)) {
      const letters = word.value.slice(1);
      const at = [...letters].findIndex((c) => TAR_VALUES.includes(c));
      if ((at < 0 ? letters : letters.slice(0, at)).includes("x")) return true;
      if (at === letters.length - 1) i++;
    }
  }
  return false;
}

function clusterHas(args: WordToken[], letter: string): boolean {
  return args.some((a) => (a.dynamic ? mayBeOption(a) : /^-[^-]/.test(a.value) && a.value.includes(letter)));
}

/** `ar x` and `jar xf` name their mode in the first word, with or without a `-`. */
function modeHas(first: WordToken | undefined, letter: string): boolean {
  if (first === undefined) return false;
  return first.dynamic || (/^-?[A-Za-z]+$/.test(first.value) && first.value.includes(letter));
}

/** 7-Zip's command is its first word that is not a `-` switch: `x` and `e` extract. */
function sevenZipExtracts(args: WordToken[]): boolean {
  const command = args.find((a) => a.dynamic || !a.value.startsWith("-"));
  return command !== undefined && (command.dynamic || ["x", "e"].includes(command.value.toLowerCase()));
}

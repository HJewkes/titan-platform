import type { RedirectToken, Token, WordToken } from "./tokens.js";

/** Commands whose output `numericOutput` may read as digits; a function or alias of one of these names voids the PATH mark. */
export const NUMERIC_COMMANDS: ReadonlySet<string> = new Set(["date", "wc", "grep", "stat", "nproc", "id", "tput", "seq", "git", "du", "cut"]);

/** `date` directives that print only digits, with optional flags and width; no `E`/`O` locale modifier. */
const DATE_FORMAT_RE = /^\+(?:%[-_0^#]*\d*[sNHMSdmYyjuweklICGgVUW]|\d)+$/;
/** GNU `stat` directives that print a number. */
const STAT_FORMAT_RE = /^(?:%[sYXZWihugbBo])+$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

interface Stage {
  words: string[];
  redirects: RedirectToken[];
  /** No word expands at run time or holds a newline. */
  literal: boolean;
}

/**
 * Whether a command substitution's output is only digits, whatever the files it reads hold: `date +%s`,
 * `wc -l < f`, `… | wc -l`, `grep -c p f`, `stat -c %s f`, `nproc`, `id -u`, `tput cols`, `seq 1 3`,
 * `git rev-list --count HEAD` and `du -s … | cut -f1`. The stages that print are literal; earlier stages of a pipe
 * into `wc` are walked as commands of their own. The caller checks that nothing on the line rebinds these names.
 */
export function numericOutput(tokens: Token[]): boolean {
  const stages = pipelineStages(tokens);
  const last = stages?.at(-1);
  if (!stages || !last?.literal) return false;
  if (last.words[0] === "wc") return wcCounts(last, stages.length > 1);
  if (stages.length === 2) return duSizes(stages);
  return stages.length === 1 && last.redirects.length === 0 && singleNumeric(last.words);
}

/** The stages of a plain pipeline, or null for any other list. */
function pipelineStages(tokens: Token[]): Stage[] | null {
  let stage: Stage = { words: [], redirects: [], literal: true };
  const stages = [stage];
  for (const t of tokens) {
    if (t.type === "op" && t.value === "|" && stage.words.length > 0) {
      stage = { words: [], redirects: [], literal: true };
      stages.push(stage);
    } else if (t.type === "word") {
      stage.words.push(t.value);
      stage.literal &&= isLiteral(t);
    } else if (t.type === "redirect") stage.redirects.push(t);
    else return null;
  }
  return stages;
}

const isLiteral = (w: WordToken) => !w.dynamic && !w.computed && !w.value.includes("\n");

/** `wc` counting its input alone: count options only, and only `<` redirects when nothing pipes into it. */
function wcCounts({ words, redirects }: Stage, piped: boolean): boolean {
  if (!words.slice(1).every((w) => /^-[lcwm]+$/.test(w))) return false;
  return piped ? redirects.length === 0 : redirects.every((r) => r.op === "<" && r.fd === null);
}

/** `du -s… | cut -f1`: `-s` prints only the literal operands, so the first field of each line is a size. */
function duSizes([du, cut]: Stage[]): boolean {
  if (!du?.literal || !cut || du.words[0] !== "du" || du.redirects.length > 0 || cut.redirects.length > 0 || cut.words[0] !== "cut") return false;
  const options = du.words.slice(1).filter((w) => w.startsWith("-"));
  const field = cut.words.slice(1).join(" ");
  return options.every((o) => /^-[skmbLxc]+$/.test(o)) && options.some((o) => o.includes("s")) && (field === "-f1" || field === "-f 1");
}

function singleNumeric([name, ...args]: string[]): boolean {
  switch (name) {
    case "date":
      return dateDigits(args);
    case "grep":
      return grepCounts(args);
    case "stat":
      return statNumbers(args);
    case "nproc":
      return args.every((a) => a === "--all" || /^--ignore=\d+$/.test(a));
    case "id":
      return idNumbers(args);
    case "tput":
      return args.length === 1 && ["cols", "lines", "colors"].includes(args[0] ?? "");
    case "seq":
      return args.length > 0 && args.every((a) => a === "-w" || NUMBER_RE.test(a)) && args.some((a) => NUMBER_RE.test(a));
    case "git":
      return args[0] === "rev-list" && args.includes("--count") && !args.some((a) => /^--(?:format|pretty|header)/.test(a));
    default:
      return false;
  }
}

/** `date` with one `+FORMAT` of digit directives, and only options that pick the time or the zone. */
function dateDigits(args: string[]): boolean {
  let format = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a.startsWith("+")) {
      if (format || !DATE_FORMAT_RE.test(a)) return false;
      format = true;
    } else if (a === "-d" || a === "-r") {
      if (args[++i] === undefined) return false;
    } else if (!["-u", "--utc", "-j"].includes(a) && !/^--(?:date|reference)=/.test(a)) return false;
  }
  return format;
}

/** `grep -c` with one pattern and at most one file, or `-h`, so no `file:` prefix comes before a count. */
function grepCounts(args: string[]): boolean {
  let [count, bare] = [false, false];
  const operands: string[] = [];
  for (const a of args) {
    if (/^-[civwxEFh]+$/.test(a)) {
      count ||= a.includes("c");
      bare ||= a.includes("h");
    } else if (a.startsWith("-")) return false;
    else operands.push(a);
  }
  return count && operands.length > 0 && (operands.length <= 2 || bare);
}

/** GNU `stat` with a format of numeric directives only; without `%n` no file name is printed. */
function statNumbers(args: string[]): boolean {
  let [format, files] = [false, 0];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    let value: string | undefined;
    if (a === "-c") value = args[++i];
    else if (a.startsWith("-c")) value = a.slice(2);
    else if (/^--(?:format|printf)=/.test(a)) value = a.slice(a.indexOf("=") + 1);
    else if (a === "-L") continue;
    else if (a.startsWith("-")) return false;
    else {
      files++;
      continue;
    }
    if (value === undefined || !STAT_FORMAT_RE.test(value)) return false;
    format = true;
  }
  return format && files > 0;
}

/** `id` printing ids, never names: `-u`, `-g`, `-G` with `-r`, and at most one user. */
function idNumbers(args: string[]): boolean {
  const options = args.filter((a) => a.startsWith("-"));
  const users = args.length - options.length;
  return options.every((o) => /^-[ugGr]+$/.test(o)) && options.some((o) => /[ugG]/.test(o)) && users <= 1;
}

import { posix } from "node:path";

/** One simple command: its words with quotes removed, plus the targets of its redirections. */
interface Segment {
  words: string[];
  redirects: string[];
}

const SEPARATORS = new Set([";", "&", "|", "(", ")", "{", "}", "\n", "`"]);
const REDIRECTS = new Set(["<", ">"]);

class SegmentBuilder {
  readonly segments: Segment[] = [];
  private current: Segment = { words: [], redirects: [] };
  private word: string | undefined;
  private redirectNext = false;

  append(text: string): void {
    this.word = (this.word ?? "") + text;
  }

  endWord(): void {
    if (this.word === undefined) return;
    (this.redirectNext ? this.current.redirects : this.current.words).push(this.word);
    this.word = undefined;
    this.redirectNext = false;
  }

  redirect(): void {
    this.endWord();
    this.redirectNext = true;
  }

  endSegment(): void {
    this.endWord();
    if (this.current.words.length > 0 || this.current.redirects.length > 0) this.segments.push(this.current);
    this.current = { words: [], redirects: [] };
    this.redirectNext = false;
  }
}

/** Reads one quoted span starting after its opening quote; returns its text and the index after the closing quote. */
function quoted(command: string, start: number, quote: string): [string, number] {
  let text = "";
  let index = start;
  while (index < command.length && command[index] !== quote) {
    if (quote === '"' && command[index] === "\\" && index + 1 < command.length) index++;
    text += command[index];
    index++;
  }
  return [text, index + 1];
}

/**
 * Splits a shell command into simple commands. It is deliberately loose (no expansion, no heredoc bodies): the audit
 * reads what a command could reach, and anything it cannot parse is still scanned as words.
 */
export function shellSegments(command: string): Segment[] {
  const builder = new SegmentBuilder();
  let index = 0;
  while (index < command.length) {
    const char = command[index] ?? "";
    if (char === "'" || char === '"') {
      const [text, next] = quoted(command, index + 1, char);
      builder.append(text);
      index = next;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) builder.append(command[index + 1] ?? "");
    else if (SEPARATORS.has(char)) builder.endSegment();
    else if (REDIRECTS.has(char)) builder.redirect();
    else if (/\s/.test(char)) builder.endWord();
    else builder.append(char);
    index += char === "\\" ? 2 : 1;
  }
  builder.endSegment();
  return builder.segments;
}

/** `$( … )` and backtick bodies run even inside double quotes, so each is scanned as a command of its own. */
export function substitutions(command: string): string[] {
  const bodies = [...command.matchAll(/\$\(([^()]*)\)/g), ...command.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? "");
  return bodies.filter((body) => body.trim() !== "");
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PLAIN_WRAPPERS = new Set(["command", "exec", "nohup", "builtin", "time", "nice", "sudo", "setsid", "stdbuf", "env"]);
const ARG_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir"]),
  timeout: new Set(["-k", "-s", "--kill-after", "--signal"]),
  xargs: new Set(["-n", "-I", "-L", "-P", "-d", "-a", "-E", "-s"]),
  nice: new Set(["-n"]),
};
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

export const commandName = (word: string): string => posix.basename(word);

/** Index after a wrapper's own options (and the duration `timeout` takes), where the wrapped command starts. */
function skipOptions(words: readonly string[], start: number, wrapper: string): number {
  const withArg = ARG_FLAGS[wrapper] ?? new Set<string>();
  let index = start;
  while (index < words.length && ((words[index] ?? "").startsWith("-") || ASSIGNMENT.test(words[index] ?? ""))) {
    index += withArg.has(words[index] ?? "") ? 2 : 1;
  }
  return wrapper === "timeout" ? index + 1 : index;
}

/** The words of the command a wrapper chain (`env X=1 command timeout 9 xargs …`) finally runs. */
export function unwrap(words: readonly string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    const name = commandName(word);
    if (ASSIGNMENT.test(word)) index++;
    else if (PLAIN_WRAPPERS.has(name) || name === "timeout" || name === "xargs") index = skipOptions(words, index + 1, name);
    else break;
  }
  return words.slice(index);
}

/** The script a shell runs with `-c` (or a combined flag such as `-lc`), when it runs one. */
export function shellScript(words: readonly string[]): string | undefined {
  const flag = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
  return flag === -1 ? undefined : words[flag + 1];
}

const GIT_ARG_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/** git's subcommand, past its global options. */
export function gitSubcommand(words: readonly string[]): string | undefined {
  let index = 1;
  while (index < words.length && (words[index] ?? "").startsWith("-")) index += GIT_ARG_OPTIONS.has(words[index] ?? "") ? 2 : 1;
  return words[index];
}

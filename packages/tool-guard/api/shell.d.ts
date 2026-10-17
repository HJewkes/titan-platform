/** How deep the readers of one command are, shared like its reading budget. */
interface Nesting {
    depth: number;
}

/**
 * Shared by every lexer state reading one source: each `((` position, and the `$` of each `$((`,
 * is tried once. The spend and the nesting are shared further, with heredoc bodies and backticks
 * lexed from that source, so all trials of one command read at most a few times its length and
 * crafted nesting can neither stall the guard nor overflow its stack.
 */
interface ArithTrials {
    ends: Map<number, number>;
    spend: {
        left: number;
    };
    nesting: Nesting;
}

/** A `$NAME` or `${NAME}` reference; `start` and `end` index into the word's `value`. */
interface VarRef {
    name: string;
    start: number;
    end: number;
}
/**
 * One shell word with quotes removed. `dynamic` means its value is only known at run time;
 * `computed` means some of that comes from something other than a plain variable reference.
 */
interface WordToken {
    type: "word";
    value: string;
    dynamic: boolean;
    quoted: boolean;
    /** Quotes or escapes split the word, or `$'...'` decoded it: `~/".x"`, `.n''x`, `.n\x`. */
    spliced: boolean;
    computed: boolean;
    /** Where in `value` the word spelled out a `$(`, `${` or backtick itself; bash evaluates that text wherever it reads the value as arithmetic. */
    codeAt?: number[];
    /** A `$` or backtick expansion sits outside double quotes, so it word-splits even when other parts are quoted. */
    unquotedExpansion?: true;
    refs: VarRef[];
    /** Token lists of command substitutions, which run even when quoted. */
    subs: Token[][];
    /** Where each `$( )` or backquote's output lands in `value`, which leaves it out, and which of `subs` it is. */
    cuts?: Array<{
        at: number;
        sub: number;
    }>;
    /** The text before literal variables were expanded into it; absent when nothing was expanded. */
    typed?: string;
    /** Set on a word variable tracking adds itself, never by the lexer; only such a word can assign a hidden slot. */
    hidden?: true;
    /** A `{name}` before a redirect: zsh reads it as the redirect's descriptor and dash as a word; bash only when glued. */
    namedFd?: "glued" | "spaced";
}
interface OpToken {
    type: "op";
    value: string;
    /** Set on the first `(` of a `((` the lexer reads as an arithmetic command; absent on nested subshells. */
    arith?: true;
}
/** Process substitutions, `<(...)` and `>(...)`. */
interface SubsToken {
    type: "subs";
    subs: Token[][];
}
/** `target` is the word after the operator; for a heredoc it is the delimiter and `body` is the text. */
interface RedirectToken {
    type: "redirect";
    op: string;
    fd: string | null;
    /** The `{name}` word before the operator; in the reading that takes it as the descriptor, `fd` holds it too. */
    named?: string;
    target: WordToken | null;
    body: string | null;
    /** Command substitutions in an unquoted heredoc body, which the shell runs before the command. */
    subs: Token[][];
}
type Token = WordToken | OpToken | SubsToken | RedirectToken;

declare class ParseError extends Error {
    name: string;
}

/** Splits a command string into words, operators, redirections and substitutions. Throws `ParseError`. */
declare function tokenize(src: string, trials?: ArithTrials): Token[];

/**
 * Alias name to the shell texts it may expand to; a name can carry more than one (a built-in floor and the shell's own).
 * An aliased command is read as its expansion as well as as written, so the alias reading only adds commands.
 */
type AliasTable = ReadonlyMap<string, readonly string[]>;

/** The redirects that feed a descriptor, whether the pipe does, text a parent's pipe left there, and whether some source is unknowable. */
interface Feeds {
    redirects: Set<RedirectToken>;
    pipe: boolean;
    texts: string[];
    unknown: boolean;
}
/** What each descriptor holds before a command's own redirects open: the shell's, or the command's that runs it. */
type Descriptors = (fd: number) => Feeds;

/**
 * How a command was reached: a `( )` subshell or a substitution, a shell's `-c` string or a wrapper's
 * script option, `eval`, `xargs`, a heredoc or here-string fed to a shell, text piped into one, `find -exec`.
 */
type Wrapping = "subshell" | "sh-c" | "eval" | "xargs" | "heredoc-shell" | "piped-shell" | "find-exec";
/** A run of commands joined only by `&&`; any other operator, a group or a nested list starts a new one. Compared by identity. */
interface Chain {
    /** The operator before the run's first command, null at the start of a list. */
    readonly start: string | null;
}
/** One simple command the shell would run. */
interface SimpleCommand {
    /** Null when no word names the command statically: only assignments or redirections, or a dynamic first word. */
    name: string | null;
    /** The command word as typed, after literal expansion (`./x.sh`, `~/bin/x`); null when `name` is. */
    path: string | null;
    args: WordToken[];
    /** Literal `NAME=value` prefixes. */
    env: Record<string, string>;
    redirects: RedirectToken[];
    /** Working directory, null when it cannot be known. */
    dir: string | null;
    /** The wrappings that reached the command, outermost first; empty at the top level. */
    wrapping: Wrapping[];
    /** The operator joining the command to the next on its list (`&&`, `||`, `;`, `\n`, `|`, `&`), null when none follows. */
    next: string | null;
    /** The operator joining the previous command on its list to this one, null when none precedes. */
    prev: string | null;
    /** Whether `!` negates the status of the pipeline the command is in. */
    negated: boolean;
    chain: Chain;
    /** Set on a command only an added xargs reading runs; it may add actions but never fails the line or moves its state. */
    added?: true;
    /** What its descriptors held before its own redirects, when a command that runs it set them up (`bash -c bash < f`). */
    inherited?: Descriptors;
}
interface ExtractOptions {
    cwd?: string | null;
    /** Expands `~`, `$HOME` and a bare `cd`; null leaves them unknown. */
    home?: string | null;
    /** Reads every command word lower-cased, as a filesystem that finds `GIT` as git runs it; arguments stay as written. */
    foldCase?: boolean;
    /**
     * Command names classify reads other than by their arguments' default treatment: guarded programs, the names a
     * family adds a verdict for or exempts, interpreters and `source`. A reading of dynamic wrapper words is skipped only
     * when neither its name nor the command's as written is one. Omitted: every name.
     */
    guarded?: ReadonlySet<string>;
    /**
     * Past the budget of dynamic wrapper readings, read the rest as if it had none, as main does, instead of throwing
     * `ReadingLimitError`. For a script the line runs, which the user cannot split further.
     */
    stopPastCap?: boolean;
    aliases?: AliasTable;
    /** Called with each script text the walk reads (a `-c` string, eval text, a heredoc or piped script), before reading it. */
    onScript?: (text: string) => void;
}
/**
 * Every simple command the shell would run, including ones nested in substitutions, `bash -c`
 * strings, `eval` and heredocs fed to a shell. Literal variable assignments are expanded into
 * later words. Throws `ParseError`.
 */
declare function extractCommands(src: string, options?: ExtractOptions): SimpleCommand[];

/** A line whose dynamic wrapper words leave more readings that may decide than the budget walks; the hook denies it unchecked. */
declare class ReadingLimitError extends Error {
    constructor();
}

/** A line that rebinds a command name (`hash y=/usr/bin/git`, `commands[y]=…`); the hook denies it unchecked. */
declare class CommandRebindingError extends ReadingLimitError {
    constructor();
}

interface GitInvocation {
    /** Directory git operates in after `-C`, null when unknown. */
    dir: string | null;
    /** Paths from `--git-dir` and `--work-tree`; any entry means `dir` alone does not locate the repository. */
    otherPaths: Array<string | null>;
    /** `-c key=value` overrides. */
    config: string[];
    sub: string | null;
    /** True when the subcommand is, or an unquoted dynamic option word could split into, a word git could run as anything. */
    subDynamic: boolean;
    subArgs: WordToken[];
}
/** Parses `git [global options] <subcommand> [args]` and resolves where it operates. */
declare function parseGit(args: WordToken[], dir: string | null, home?: string | null): GitInvocation;
interface SplitArgs {
    /** Normalised to `--long` names and single `-x` letters. */
    flags: Set<string>;
    positionals: WordToken[];
}
/** Separates flags from positionals; `valueOpts` names options whose value is the next word. */
declare function splitArgs(args: WordToken[], valueOpts?: Set<string>): SplitArgs;

/** Absolute path a word names from `dir`, or null when the word is dynamic or the base is unknown. */
declare function resolvePath(dir: string | null, word: WordToken | null | undefined, home: string | null): string | null;

export { type AliasTable, type Chain, CommandRebindingError, type ExtractOptions, type GitInvocation, type OpToken, ParseError, ReadingLimitError, type RedirectToken, type SimpleCommand, type SplitArgs, type SubsToken, type Token, type VarRef, type WordToken, type Wrapping, extractCommands, parseGit, resolvePath, splitArgs, tokenize };

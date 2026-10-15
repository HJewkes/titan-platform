import { Chain, SimpleCommand } from './shell/index.js';
export { AliasTable, ExtractOptions, GitInvocation, OpToken, ParseError, ReadingLimitError, RedirectToken, SplitArgs, SubsToken, Token, VarRef, WordToken, Wrapping, extractCommands, parseGit, resolvePath, splitArgs, tokenize } from './shell/index.js';
import { ActorClass, PolicyTable } from '@titan-design/authority';

interface EventMeta {
    toolName: string;
    cwd: string | null;
    sessionId: string | null;
    toolUseId: string | null;
}
/** One PreToolUse event reduced to what the classifier reads. Unknown tools become `other`. */
type HookEvent = (EventMeta & {
    kind: "bash";
    command: string;
})
/** Read, and Grep, whose missing path becomes `.`; a relative path resolves against `cwd`. */
 | (EventMeta & {
    kind: "read";
    path: string;
})
/** Edit, Write, MultiEdit and NotebookEdit. */
 | (EventMeta & {
    kind: "write";
    path: string;
}) | {
    kind: "other";
    toolName: string;
};
type ReadEvent = Extract<HookEvent, {
    kind: "read";
}>;
type WriteEvent = Extract<HookEvent, {
    kind: "write";
}>;
/** An event whose shape broke Claude Code's contract; the hook fails open on it and logs `shape`. */
interface MalformedEvent {
    kind: "malformed";
    toolName: string | null;
}
/** Validates a parsed PreToolUse payload. Never throws. */
declare function parseHookEvent(raw: unknown): HookEvent | MalformedEvent;

/**
 * One guarded location. `pattern` starts with `~/` (home), `**\/` (any directory) or `/` (the
 * root); `*` and `?` stay within one segment, and a trailing `/**` covers the directory itself
 * and everything under it.
 */
interface GuardedPath {
    /** Logged instead of the path the agent typed. */
    id: string;
    pattern: string;
    except?: readonly string[];
    /** Concrete paths the pattern covers, for testing a glob or a directory; required when `pattern` has a wildcard. */
    samples?: readonly string[];
}
interface GuardedList {
    paths: readonly GuardedPath[];
    /** File names distinctive enough to match on their own, as in `find ~ -name .netrc`. */
    basenames: readonly string[];
}
/** The guarded path lists of section 3.3 of the TP-403 plan, fixed by owner decision D4. */
declare const GUARDED_PATHS: {
    readonly secret: GuardedList;
    readonly config: GuardedList;
};

/** What the host knows. The filesystem arrives as a port so the classifier stays pure. */
interface ClassifyContext {
    home: string;
    /** Realpath of an existing path, null when it does not exist. */
    readLink(path: string): string | null;
    /** Current branch of the checkout at `dir`, null when detached or not a checkout. */
    readHead(dir: string): string | null;
    /** Text of a script run by path, null when it cannot be read. */
    readScript(path: string): string | null;
    /**
     * Set by the classifier once a line writes a script: every text the script may then hold, the disk's included, or
     * null once the line left more than the classifier tracks.
     */
    scriptReadings?(path: string): string[] | null;
    /** Whether a PATH lookup finds a program whatever the case of its name, so `GIT push` runs git. */
    foldCase?: boolean;
    /**
     * Set by the classifier inside an `&&` chain a branch switch guards: the chain, and the state every command outside it
     * sees. A field rather than identity, so a step that copies the state keeps it.
     */
    chainTrust?: {
        chain: Chain;
        fallback: ClassifyContext;
    };
}
type GuardedAction = "merge" | "release" | "secret-read" | "authority-config" | "private-egress";
/** What an event would do, with no actor attached. */
interface ClassifiedAction {
    action: GuardedAction;
    spelling: SpellingId;
    /** Safe fields only: a guarded pattern id, never the path the agent typed. */
    subject: Record<string, string>;
    remedy: string;
}
/** One family of classified spellings. `classify.ts` holds the registry. */
interface Family {
    /** Command names `bash` sees; omitted means every command, including ones with no static name. */
    names?: ReadonlySet<string>;
    /**
     * For a family that sees every command, the names it reads differently from the rest: those it adds a verdict for and
     * those whose arguments it exempts. Build it from the same sets `bash` checks, so the two cannot drift apart.
     */
    verbs?: ReadonlySet<string>;
    bash?(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[];
    read?(event: ReadEvent, ctx: ClassifyContext): ClassifiedAction[];
    write?(event: WriteEvent, ctx: ClassifyContext): ClassifiedAction[];
    /** The context later commands on the same line see, when `cmd` changes it; undefined leaves it as it is. */
    after?(cmd: SimpleCommand, ctx: ClassifyContext): ClassifyContext | undefined;
}

type FamilyName = "secret" | "config" | "merge" | "release" | "egress";
interface SpellingRow {
    family: FamilyName;
    action: GuardedAction;
    remedy: string;
}
/** Every spelling the classifier emits, keyed by id. A family adds its rows here and its handler to `classify.ts`. */
declare const SPELLINGS: {
    readonly "read.secret": SpellingRow;
    readonly "read.secret-symlink": SpellingRow;
    readonly "grep.secret": SpellingRow;
    readonly "bash.secret.cat": SpellingRow;
    readonly "bash.secret.head-tail-less": SpellingRow;
    readonly "bash.secret.grep": SpellingRow;
    readonly "bash.secret.cp-mv": SpellingRow;
    readonly "bash.secret.encode": SpellingRow;
    readonly "bash.secret.redirect-in": SpellingRow;
    readonly "bash.secret.here-string": SpellingRow;
    readonly "bash.secret.subshell": SpellingRow;
    readonly "bash.secret.absolute": SpellingRow;
    readonly "bash.secret.home-relative": SpellingRow;
    readonly "bash.secret.symlink": SpellingRow;
    readonly "bash.secret.link-then-read": SpellingRow;
    readonly "bash.secret.var-indirection": SpellingRow;
    readonly "bash.secret.quoting": SpellingRow;
    readonly "bash.secret.glob": SpellingRow;
    readonly "bash.secret.sh-c": SpellingRow;
    readonly "bash.secret.xargs": SpellingRow;
    readonly "bash.secret.inline-interpreter": SpellingRow;
    readonly "bash.secret.heredoc-shell": SpellingRow;
    readonly "bash.secret.script-by-path": SpellingRow;
    readonly "bash.secret.keychain": SpellingRow;
    readonly "bash.secret.mention": SpellingRow;
    readonly "write.config": SpellingRow;
    readonly "bash.config.redirect-out": SpellingRow;
    readonly "bash.config.tee": SpellingRow;
    readonly "bash.config.cp-mv-ln": SpellingRow;
    readonly "bash.config.in-place": SpellingRow;
    readonly "bash.config.remove": SpellingRow;
    readonly "bash.config.interpreter": SpellingRow;
    readonly "bash.config.git-hooks": SpellingRow;
    readonly "bash.config.git-config-hookspath": SpellingRow;
    readonly "bash.config.claude-cli": SpellingRow;
    readonly "bash.config.mention": SpellingRow;
    readonly "bash.merge.gh-pr-merge": SpellingRow;
    readonly "bash.merge.gh-api-merge": SpellingRow;
    readonly "bash.merge.gh-api-merges": SpellingRow;
    readonly "bash.merge.gh-api-graphql": SpellingRow;
    readonly "bash.merge.curl-api": SpellingRow;
    readonly "bash.merge.git-merge-protected": SpellingRow;
    readonly "bash.merge.git-push-protected": SpellingRow;
    readonly "bash.merge.git-push-implicit": SpellingRow;
    readonly "bash.merge.git-push-all": SpellingRow;
    readonly "bash.release.npm-publish": SpellingRow;
    readonly "bash.release.pnpm-publish": SpellingRow;
    readonly "bash.release.yarn-bun-publish": SpellingRow;
    readonly "bash.release.changeset-publish": SpellingRow;
    readonly "bash.release.npm-registry-mutation": SpellingRow;
    readonly "bash.release.gh-release": SpellingRow;
    readonly "bash.release.gh-workflow-run": SpellingRow;
    readonly "bash.release.wrangler-deploy": SpellingRow;
    readonly "bash.release.version-packages-merge": SpellingRow;
    readonly "bash.egress.gh-gist": SpellingRow;
    readonly "bash.egress.curl-upload": SpellingRow;
    readonly "bash.egress.wget-upload": SpellingRow;
    readonly "bash.egress.httpie": SpellingRow;
    readonly "bash.egress.raw-socket": SpellingRow;
    readonly "bash.egress.remote-copy": SpellingRow;
    readonly "bash.egress.cloud-copy": SpellingRow;
    readonly "bash.egress.git-push-url": SpellingRow;
};
type SpellingId = keyof typeof SPELLINGS;

/**
 * What an event would do. Pure: the filesystem is reached only through `ctx`. Throws the
 * shell's `ParseError` for a Bash command it cannot parse and `ReadingLimitError` for one with more
 * dynamic wrapper readings or script text than it checks; the hook owns that failure policy.
 */
declare function classify(event: HookEvent, ctx: ClassifyContext): ClassifiedAction[];

type PreferenceId = "R86" | "R50" | "R31" | "R127" | "R133" | "R64" | "R164" | "R175";
/** What a row needs that the command text does not carry. */
interface PreferenceContext {
    /** Whether the session is a seat, where every merge goes through `seat-merge`. */
    seat: boolean;
    /** Whether the session works in an agent worktree, where CI runs the full suite on the PR. Default false. */
    agentWorktree?: boolean;
}
interface PreferenceHit {
    id: PreferenceId;
    /** One sentence telling the agent what to do instead. */
    message: string;
}
interface PreferenceRow {
    id: PreferenceId;
    message: string;
    matches(commands: SimpleCommand[], ctx: PreferenceContext): boolean;
}
/** The preference rows, in report order. Each matcher reads only the parsed commands and `ctx`. */
declare const PREFERENCES: readonly PreferenceRow[];
/** The preference rows a parsed command list breaks. Pure: no filesystem, environment or clock. */
declare function checkPreferences(commands: SimpleCommand[], ctx: PreferenceContext): PreferenceHit[];

/** Every agent class the hook cannot rule out (owner decision D2): markers in the env do not narrow it. */
declare const AGENT_CANDIDATES: readonly ActorClass[];
/** Who made the call, as far as the hook can tell. The classifier never decides this. */
interface ActorObservation {
    candidates: readonly ActorClass[];
    /** `AGENT_CHAT_AGENT_ID`, else the session id, else `unknown`. */
    id: string;
}
/**
 * The actor for one event: always an agent. The hook runs as the same OS user as the agent, so no
 * variable, file or process fact it can read is one the agent could not produce, and owner authority
 * is never granted here. The owner takes a guarded action from a terminal outside Claude Code.
 */
declare function observeActor(env: Readonly<Record<string, string | undefined>>, sessionId: string | null): ActorObservation;

/** The action, spelling and rule behind a decision; logged on a deny. */
interface Matched {
    ruleId: string | null;
    action: GuardedAction;
    spelling: SpellingId;
    subject: Record<string, string>;
}
/** Pass carries the strictest match when anything was classified, so a caller acting for an owner class can record it. */
type GuardDecision = {
    outcome: "pass";
    matched: Matched | null;
} | ({
    outcome: "deny";
    reason: string;
} & Matched);
/**
 * Evaluates every (action, candidate) pair and keeps the strictest verdict: deny beats gate beats
 * allow. A gate denies too, since this hook has no gate door to check (TP-404 adds one).
 */
declare function decide(actions: readonly ClassifiedAction[], actor: ActorObservation, table?: PolicyTable): GuardDecision;

/** The fixed fields of a deny line, in log order. Nothing else is ever written. */
interface DecisionLine {
    ts: Date;
    kind: "deny";
    rule: string | null;
    action: string;
    spelling: string;
    actor: readonly ActorClass[];
    actorId: string;
    session: string | null;
    tool: string;
    toolUse: string | null;
    subject: Record<string, string>;
}
type ErrorClass = "parse" | "shape" | "table" | "exception" | "oversize";
interface ErrorLine {
    ts: Date;
    cls: ErrorClass;
    tool: string | null;
    session: string | null;
}
declare function formatDecisionLine(line: DecisionLine): string;
declare function formatErrorLine(line: ErrorLine): string;
/** `$TITAN_TOOL_GUARD_LOG`, else `${XDG_STATE_HOME:-$HOME/.local/state}/titan-tool-guard/guard.log`. */
declare function logPath(env: Readonly<Record<string, string | undefined>>, home: string): string;

type DecideFn = (actions: readonly ClassifiedAction[], actor: ActorObservation) => GuardDecision;
interface HookPort {
    context: ClassifyContext;
    now(): Date;
    /** Loads the authority table lazily, so a broken table fails closed only for events that classify. */
    loadDecide(): Promise<DecideFn>;
}
/** What the bin prints on stdout (empty, or one deny answer) and the lines it appends to the log. */
interface HookResult {
    stdout: string;
    log: string[];
}
type Env = Readonly<Record<string, string | undefined>>;
/**
 * Answers one PreToolUse event. Never throws and never asks or allows: it either denies through
 * the returned stdout or stays silent. A Bash command it cannot classify denies; any other failure
 * fails open unless the raw text names something guarded (plan section 7, owner decision D6).
 */
declare function handle(input: string, env: Env, port: HookPort): Promise<HookResult>;

/** The read-only filesystem calls the hook makes. Nothing here, or anywhere in this package, writes a file. */
interface ReadFs {
    realpath(p: string): string;
    readHead(p: string, max: number): string;
    isFile(p: string): boolean;
    /** Whether a lookup finds a file whatever the case of its name. */
    foldsCase?: boolean;
}
/** The classifier's context over a read-only filesystem. Every port returns null rather than throwing. */
declare function nodeContext(home: string, rfs?: ReadFs): ClassifyContext;

/** The PreToolUse entry the owner pastes into `hooks.PreToolUse`, after the git-safety entry. */
declare const SETTINGS_ENTRY: {
    readonly matcher: "Bash|Read|Grep|Edit|Write|MultiEdit|NotebookEdit";
    readonly hooks: readonly [{
        readonly type: "command";
        readonly command: "node \"$HOME/.claude/hooks/authority-guard/node_modules/@titan-design/tool-guard/dist/bin.js\" hook";
        readonly timeout: 5;
    }];
};

export { AGENT_CANDIDATES, type ActorObservation, Chain, type ClassifiedAction, type ClassifyContext, type DecideFn, type DecisionLine, type ErrorClass, type ErrorLine, type Family, type FamilyName, GUARDED_PATHS, type GuardDecision, type GuardedAction, type GuardedList, type GuardedPath, type HookEvent, type HookPort, type HookResult, type MalformedEvent, type Matched, PREFERENCES, type PreferenceContext, type PreferenceHit, type PreferenceId, type ReadEvent, type ReadFs, SETTINGS_ENTRY, SPELLINGS, SimpleCommand, type SpellingId, type WriteEvent, checkPreferences, classify, decide, formatDecisionLine, formatErrorLine, handle, logPath, nodeContext, observeActor, parseHookEvent };

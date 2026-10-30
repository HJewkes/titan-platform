/** Which return-contract block a profile takes. */
declare const RETURN_CONTRACTS: readonly ["implementer", "reviewer"];
type ReturnContract = (typeof RETURN_CONTRACTS)[number];
/**
 * CC-286: the one copy of the return contract. `<spawner>` is the only
 * placeholder the broker fills; the rest is for the agent to resolve.
 *
 * Compiled in rather than read from a file: the broker runs from a checkout that
 * agents write to, so a file read at spawn time let any of them reword the
 * contract for every later spawn. A change here needs a build and a restart.
 */
/**
 * A block is paid for on every contracted spawn, so it stays a paragraph. CC-1184 raised it from 2450
 * for `REVIEW_TREE_RULE`: concurrent reviewers each installing base, old and head trees filled /tmp.
 * CC-1384 raised it from 2600 for `GH_READS_RULE` and the filled visibility line, which replace reads
 * the profiles refused 1,700 times a week. CC-1660 raised it from 2800 for `FRICTION_LINE`.
 */
declare const MAX_BLOCK_CHARS = 3000;
/**
 * CC-501 S3: the forms the leak guard allows. CC-897: a heredoc on stdin is scanned by the guard as it
 * stands and by gh-write again, so a body is posted in one call; writing a .md file and posting it on
 * the same line is the guard's writtenBody denial. pr-ready still reads a file: a fixed shared
 * `$TMPDIR` name let one agent post another's body (CC-725). The bd-implementer profiles carry both too.
 */
declare const BODY_FILE_RULE: string;
/** A reviewer has no Write and works in the implementer's tree, so it writes no file there. */
declare const REVIEWER_BODY_FILE_RULE: string;
/** CC-690: the mechanical blockers (dirty tree, stale base, red checks, leak terms) cost a reviewer round each. */
declare const PR_READY_RULE = "Before the first push, never after, run `agent-chat pr-ready --title <t> --body-file <f>`; fix every FAIL.";
declare const QUOTE_RULE = "Quote expansions in git and gh args (`git -C \"$dir\"`); never hold a command name in a variable.";
/**
 * CC-311: Claude Code cannot resolve a write target that holds a variable, so it asks, and a headless
 * reviewer parks on that prompt until the hook's deadline. The same edit on a literal path ran unprompted.
 */
declare const MUTANT_RULE: string;
/**
 * CC-713: a reviewer piped a bypass probe to bash from a shared main checkout, and it ran a real
 * `git push origin HEAD:main`. The burndown reviewer brief and the bd-reviewer prelude carry it too.
 */
declare const PROBE_SANDBOX_RULE: string;
/**
 * CC-452: a brief line reading exactly this keeps the implementer off Shepherd for a seat's own merge path.
 * CC-1278: it also gives the reviewer the variant that reads CI itself and may say WAIT.
 */
declare const SHEPHERD_NONE_MARKER = "Shepherd: none";
/**
 * CC-1384: the broker fills this with the repo's visibility, read at spawn. The bd-* profiles deny
 * `gh api` and `gh repo`, so an instruction to read it cost 1,060 refusals in a week.
 */
declare const VISIBILITY_PLACEHOLDER = "<repo visibility>";
/** CC-1384: the reads the profiles allow, for the `gh api` shapes they refused 823 times in a week. */
declare const GH_READS_RULE: string;
/** CC-1660: optional, one line; the daily friction digest reads `^Friction: (.+)$`, at most 200 characters. */
declare const FRICTION_LINE: string;
/** The implementer block for a brief carrying `SHEPHERD_NONE_MARKER`. */
declare const IMPLEMENTER_WITHOUT_SHEPHERD: string;
/** TP-2498: non-blocking work goes here and Shepherd files it as tasks, so nits stop costing a round. */
declare const FOLLOW_UPS_RULE: string;
/** CC-1184: three installed trees per review exhausted /tmp inodes on Linux; one install is enough. */
declare const REVIEW_TREE_RULE: string;
/** The reviewer block for a brief carrying `SHEPHERD_NONE_MARKER`: a seat merging on its own reads CI itself. */
declare const REVIEWER_WITHOUT_SHEPHERD: string;
declare const RETURN_CONTRACT_BLOCKS: Readonly<Record<ReturnContract, string>>;

/**
 * CC-398: a brief that asks for a tool the agent cannot use is found out
 * mid-run, after the spawn has paid for a session. Linting the caller's brief at
 * spawn refuses it while the spawner can still reword it. Only the caller's
 * brief is linted: the broker's own return contract names ScheduleWakeup in a
 * "never" sentence.
 */
type RepoVisibility = "public" | "private" | "internal" | "unknown";
interface BriefLintInput {
    brief: string;
    profile: {
        name: string;
        disallowedTools?: readonly string[];
    };
    surface: string;
    repoVisibility: RepoVisibility;
}
interface BriefLint {
    refusal?: string;
    warnings: string[];
}
/** A brief that needs no visibility read: the synthetic-data line is already there. */
declare const mentionsSyntheticData: (brief: string) => boolean;
declare function lintBrief(input: BriefLintInput): BriefLint;
type GhRunner = (args: readonly string[]) => Promise<string>;
/** Runs git in `cwd`; null when the command fails or prints nothing. */
type GitRunner = (args: readonly string[], cwd: string) => Promise<string | null>;
/** `owner/name` of a GitHub remote URL; undefined for any other remote. */
declare const githubRepoOf: (url: string) => string | undefined;
/**
 * The visibility of the GitHub repo a spawn's cwd belongs to, cached per repo
 * for the reader's life. Any failure is `unknown`, which warns about nothing and
 * is not cached, so one timeout does not silence the warning until a restart.
 * Both runners are the caller's: this module spawns no process.
 */
declare function repoVisibilityReader(git: GitRunner, gh: GhRunner): (cwd: string) => Promise<RepoVisibility>;

/** The slice of an agent profile that decides which return contract it takes. */
interface ContractProfile {
    name: string;
    allowedTools: readonly string[];
    disallowedTools?: readonly string[];
    /** Absent means `worker`: the contract is read from the name only for a worker. */
    role?: string;
    /** Absent means the contract is inferred from the name and grants; `none` opts out. */
    returnContract?: ReturnContract | "none";
}
/**
 * Which block a profile takes. The field wins; a profile file that predates it
 * is read by name, and only when its role and grants agree, because a wrong
 * block misleads an agent and a missing one costs the spawner a sentence.
 */
declare function contractOf(profile: ContractProfile): ReturnContract | undefined;
/** Whether a brief already carries a pasted copy of this block, in any wording or wrapping. */
declare const carriesContract: (brief: string, contract: ReturnContract) => boolean;
interface ContractInput {
    brief: string;
    profile: ContractProfile;
    /** The requester's registered name, or `HUMAN` for a CLI spawn. */
    spawner: string;
    /** A resumed conversation was handed its contract when it was first spawned. */
    resumed: boolean;
    /** The spawn's own `return_contract`: `none` when the brief states its own report format. */
    requested?: "none";
    /** CC-1384: the repo's visibility as the broker read it at spawn; absent is `unknown`. */
    visibility?: RepoVisibility;
}
/** An unread visibility is stated as such, so the agent treats the repo as public instead of probing it. */
declare const visibilityLine: (visibility?: RepoVisibility) => string;
interface Contracted {
    brief: string;
    warnings: string[];
}
/**
 * Only a line of its own counts, so a brief that mentions the marker in a sentence keeps Shepherd.
 * A list item counts too: briefs carry the marker in their checks lists (CC-737).
 */
declare const optsOutOfShepherd: (brief: string) => boolean;
/** The brief as the agent receives it. */
declare function withReturnContract(input: ContractInput): Contracted;

/**
 * CC-281 a: the every-session rules a launched agent must hold, carried in its system prompt.
 *
 * Workers launch without user skills, so a rule kept only in a skill or `~/CLAUDE.md` never
 * reaches them once that prose is deleted (CC-1135). Paid on every spawn, hence the cap.
 */
declare const STANDING_RULES_MAX_CHARS = 600;
/** True of any session, attached human or not, spawned or adopted. */
declare const SESSION_RULES: string;
/**
 * Only a spawned agent has a spawner; an adopted session is a human's own, teleported or not.
 * It yields to a channel the brief or profile names: a Shepherd reviewer's brief says its verdict
 * needs no chat_send (CC-1354).
 */
declare const SPAWNED_RULES = "Report progress, blockers and results to your spawner with chat_send unless your instructions name another channel.";
/** A profile that denies chat_send, exactly or by an MCP wildcard, cannot follow the spawner rule. */
declare const deniesChatSend: (profile: {
    disallowedTools?: string[];
}) => boolean;
declare const standingRulesFor: (adopted: boolean, canChatSend: boolean) => string;

export { BODY_FILE_RULE, type BriefLint, type BriefLintInput, type ContractInput, type ContractProfile, type Contracted, FOLLOW_UPS_RULE, FRICTION_LINE, GH_READS_RULE, type GhRunner, type GitRunner, IMPLEMENTER_WITHOUT_SHEPHERD, MAX_BLOCK_CHARS, MUTANT_RULE, PROBE_SANDBOX_RULE, PR_READY_RULE, QUOTE_RULE, RETURN_CONTRACTS, RETURN_CONTRACT_BLOCKS, REVIEWER_BODY_FILE_RULE, REVIEWER_WITHOUT_SHEPHERD, REVIEW_TREE_RULE, type RepoVisibility, type ReturnContract, SESSION_RULES, SHEPHERD_NONE_MARKER, SPAWNED_RULES, STANDING_RULES_MAX_CHARS, VISIBILITY_PLACEHOLDER, carriesContract, contractOf, deniesChatSend, githubRepoOf, lintBrief, mentionsSyntheticData, optsOutOfShepherd, repoVisibilityReader, standingRulesFor, visibilityLine, withReturnContract };

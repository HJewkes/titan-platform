import { SourceTextLocator, VerdictBlockRefusal, CiPolicy, NormalizedSessionObservation } from '@titan-design/session-read';
import { z } from 'zod';
import { LineSource } from '@titan-design/evidence';

interface ChangedFile {
    path: string;
    /** The path a renamed file came from. */
    previousPath?: string;
    additions: number;
    deletions: number;
}
/** What the caller knows about a pull request; classification reads nothing else, and no model reads the diff. */
interface PrFacts extends ReviewTarget {
    /** The base branch's head commit. */
    base: string;
    /** The registered kind; absent means unread, which takes the strict class. */
    kind?: string;
    changedFiles: readonly ChangedFile[];
    /** The caller already knows the PR touches authority, whatever its paths say. */
    authorityTouch?: boolean;
    /** The caller already knows the PR touches policy, whatever its paths say. */
    policyTouch?: boolean;
}
/** `g10` is an authority, policy, security or migration touch, an unread kind, or a large PR; everything else is `standard`. */
type ReviewClass = "g10" | "standard";
/** `untested` is a source change with no test change; `perf` is a hot-path touch. */
type PrTouch = "authority" | "policy" | "migration" | "visual" | "security" | "perf" | "dependency" | "untested" | "large";
interface PrClass {
    class: ReviewClass;
    /** The touches choose the panel's shapes; the class chooses their tier. */
    touches: readonly PrTouch[];
}
/** The question a panel member owns; each shape is a brief overlay on the common base brief. */
type ReviewShape = "correctness" | "adversary" | "tests" | "visual" | "perf";
interface PanelMember {
    shape: ReviewShape;
    /** The agent-chat profile, which carries the member's model and effort. */
    profile: string;
    /** The stable id of the member's brief variant. */
    briefId: string;
    /** Only a blocking member's FIX_FIRST blocks, and only its MERGE counts toward the panel's MERGE. */
    blocking: boolean;
    /** Planned at a sonnet profile because opus was refused. */
    degraded: boolean;
}
interface PanelPlan {
    class: PrClass;
    /** At most one member per shape. */
    members: readonly PanelMember[];
    /** Agent-chat points for one round; an estimate, never a cap. */
    spendEstimate: number;
    /** Some member is degraded. */
    degraded: boolean;
}
/** `no-verdict` and `timeout` mean a blocking member gave none, which is never read as consent. */
type PanelOutcome = "MERGE" | "FIX_FIRST" | "no-verdict" | "timeout";
interface PanelFinding {
    shape: ReviewShape;
    text: string;
    blocking: boolean;
}
interface PanelVerdict {
    outcome: PanelOutcome;
    head: string;
    /** In shape order, each labelled with the member that wrote it. */
    findings: readonly PanelFinding[];
    defectClass?: string;
    /** The dissenting member's `Closer:` line. */
    closer?: "yes" | "no";
    /** The members that said FIX_FIRST; only they re-run on the next head. */
    dissent: readonly ReviewShape[];
    degraded: readonly ReviewShape[];
    /** The class is `g10` and the opus correctness member and the adversary both said MERGE at this head, none degraded. */
    satisfiesG10: boolean;
}

/** The pull request head a reviewer is asked about. */
interface ReviewTarget {
    /** `owner/repo`. */
    repo: string;
    pr: number;
    /** 40 lowercase hex characters. */
    head: string;
}
/**
 * Whether a session holds an agent's name. `agent ls --json` reports `live`, `detached` and `exited`; `exiting` is the
 * short stretch while a session closes, `deregistered` is the broker's word for a name with no row at all, and `unknown`
 * is any other value the roster reports.
 */
type Presence = "live" | "detached" | "exiting" | "exited" | "deregistered" | "unknown";
/** The signals a dispatch reads to pick a reviewer's profile. */
interface ReviewerFacts {
    /** The run's registered kind. */
    kind?: string;
    /** The kind could not be read, so the PR takes the stricter class. */
    unread?: boolean;
    /** Additions plus deletions, generated files left out (`changedLineCount`); absent means unknown. */
    changedLines?: number;
    /** The size could not be read, so the PR takes the stricter class. */
    sizeUnread?: boolean;
    /** The PR changes a lockfile or package.json, so it takes the stricter class whatever its size. */
    dependencyTouch?: boolean;
    /** The run holds or held a G10 hold, so it takes the stricter class whatever its size or kind. */
    g10Hold?: boolean;
    /** When the run's review intent was recorded, epoch ms; a spawn gate admits deferred reviews oldest intent first. */
    intentAt?: number;
    /** The profile a panel member was planned at; when set it wins over the class the other facts pick. */
    profile?: string;
}
/** One roster row, as the dispatch port reports it. */
interface ReviewerAgent {
    name: string;
    agentId: string;
    /** Empty until the agent's session has started. */
    sessionId: string;
    presence: Presence;
    spawnedBy: string | null;
    /** The agent this one took over from, null for none; absent means the port holds no lineage, and such an agent is never resumed. */
    predecessor?: string | null;
    /** Context tokens the session holds; absent means unknown, and an unknown fill is never resumed. */
    fillTokens?: number;
    /** Epoch milliseconds of the latest write to the session's transcript, which a resume appends to; absent means unknown. */
    lastWrittenAt?: number;
    /** The profile the agent was spawned with; absent means the port does not say. */
    profile?: string;
}
/** How a caller starts a reviewer; a throw from `spawn` or `resume` that the caller does not classify as a broker outage is a refusal. */
interface ReviewerDispatch {
    roster(): Promise<readonly ReviewerAgent[]>;
    /** `target` names the repo whose checkout the reviewer starts in; `facts` pick the reviewer's profile. */
    spawn(name: string, brief: string, target: ReviewTarget, facts?: ReviewerFacts): Promise<void>;
    resume(name: string, brief: string): Promise<void>;
}
/** The dispatched reviewer whose verdict a caller waits for. */
interface AwaitVerdictInput extends ReviewTarget {
    reviewerAgentId: string;
    reviewerSessionId: string;
    /** Epoch milliseconds. */
    dispatchedAt: number;
    /** Epoch milliseconds when the reviewer's session was up; the wait counts from it. Absent on a run recorded before it existed. */
    startedAt?: number;
    /** The panel member awaited; absent means correctness. An adversary verdict must carry a `Probes:` line. */
    shape?: ReviewShape;
}
/** One assistant message, attributed by the reader to the agent and session it came from. */
interface ReviewerMessage {
    agentId: string;
    sessionId: string;
    /** Epoch milliseconds. */
    writtenAt: number;
    text: string;
    locator: SourceTextLocator;
    /** Investigative tool calls the session made before this message; absent means the reader could not count, and no floor applies. */
    investigativeCalls?: number;
    /**
     * Set only for a record the client wrote in the model's place (Claude Code's `<synthetic>` model), from the record's own
     * fields and never from its text: the API error it names, and the quota reset in epoch milliseconds. Absent means a model wrote it.
     */
    synthetic?: {
        apiError: string | null;
        resetsAt: number | null;
    };
}
/** The assistant messages of the dispatched reviewer's session, oldest first; the last one is the final message. */
interface ReviewerReader {
    read(input: AwaitVerdictInput): Promise<readonly ReviewerMessage[]>;
    /** A seat reviewer's sent messages from every complete record, finished turn or not; rejects on a damaged transcript. Absent means `read`. */
    readSeat?(input: AwaitVerdictInput): Promise<readonly ReviewerMessage[]>;
}

/** The per-deployment tables: path globs per touch, and where a PR counts as large. */
interface ClassRules {
    authority: readonly string[];
    policy: readonly string[];
    migration: readonly string[];
    visual: readonly string[];
    security: readonly string[];
    /** Hot paths: indexers, parsers, tick loops, hook scripts. */
    perf: readonly string[];
    /** A changed file matching these is a test. */
    test: readonly string[];
    /** A changed non-test file matching these is a source change. */
    source: readonly string[];
    /** Regenerated by a script from other changes, so their lines are left out of the size. */
    generated: readonly string[];
    /** Dependency manifests and lockfiles: a change here is a supply-chain touch whatever its size. */
    dependency: readonly string[];
    /** Large when additions plus deletions exceed this. */
    largeLines: number;
    /** Large when any changed file lacks line counts and the file count exceeds this. */
    largeFiles: number;
}
declare const DEFAULT_CLASS_RULES: ClassRules;
/**
 * Additions plus deletions with generated files left out; undefined when any file carries no counts. Generated lines
 * that alone pass `largeLines` are no regeneration but a hand edit, so then every line counts.
 */
declare function changedLineCount(files: readonly ChangedFile[], rules?: Pick<ClassRules, "generated" | "largeLines">): number | undefined;
/** The review-rounds audit (2026-10-11): security slices past about this many lines rarely converge in 3 rounds. */
declare const SECURITY_SLICE_LINES: number;
/** An oversize security or guard-area slice: its non-generated size, the cap it passed, and the guard paths it touches. */
interface SliceFlag {
    lines: number;
    cap: number;
    guardPaths: string[];
}
interface SliceInput {
    kind?: string;
    changedFiles: readonly ChangedFile[];
}
/**
 * Flags a slice over the cap when it is kind `security` or touches, or renames out of, a security or authority path
 * outside the generated set. Advisory only, so an unreadable count flags nothing.
 */
declare function securitySliceFlag(input: SliceInput, rules?: ClassRules): SliceFlag | undefined;
/** True when any changed file, or the path it was renamed from, is a dependency manifest or lockfile. */
declare function touchesDependency(files: readonly Pick<ChangedFile, "path" | "previousPath">[], rules?: Pick<ClassRules, "dependency">): boolean;
/** Touches the changed paths, or the paths they were renamed from, alone produce, with no kind or caller flag; a test file never counts as authority, policy or security. */
declare function pathTouches(files: readonly Pick<ChangedFile, "path" | "previousPath">[], rules?: ClassRules): PrTouch[];
/** Class and touch flags from signals alone; no model reads the diff. An unread kind takes the strict class. */
declare function classifyPr(facts: PrFacts, rules?: ClassRules): PrClass;

/** One agent-chat profile per class; the profile carries the member's model and effort. */
type ClassRoles = Record<ReviewClass, string>;
type ExtraShape = Exclude<ReviewShape, "correctness">;
/** A shape the panel adds beside correctness: on a class in `classes` with any of `touches`, or with none when `always`. */
interface ShapeRule {
    shape: ExtraShape;
    classes: readonly ReviewClass[];
    touches: readonly PrTouch[];
    blocking: boolean;
    /** The host requires the shape whatever the files touch, as a hold that asks for an adversary does. */
    always?: boolean;
}
/** Whether opus may be spawned now; the caller asks its spawn gate. */
interface Headroom {
    opus: boolean;
}
interface PanelPolicy {
    /** TP-1428's table: the correctness member's profile per class. */
    roles: ClassRoles;
    /** Profiles for the other shapes; a shape left out uses `DEFAULT_SHAPE_ROLES`. */
    shapeRoles?: Partial<Record<ExtraShape, ClassRoles>>;
    /** The shapes beside correctness, in priority order for the member cap. Absent plans correctness alone. */
    panel?: readonly ShapeRule[];
    /** Brief id per shape; a shape left out uses its own name. */
    briefIds?: Partial<Record<ReviewShape, string>>;
    /** Each opus profile and the sonnet profile it falls back to; a profile not listed is sonnet. */
    sonnetFor?: Record<string, string>;
    /** Points one member costs per round, by model; an estimate, never a cap. */
    points?: {
        opus: number;
        sonnet: number;
    };
}
declare const DEFAULT_CLASS_ROLES: ClassRoles;
/** Sonnet everywhere: the one opus seat per head is the g10 correctness member's. */
declare const DEFAULT_SHAPE_ROLES: Record<ExtraShape, ClassRoles>;
/** The plan's class table. `tests` stays advisory here; a bad fix-proof result makes it block at aggregation, and missing when unplanned. */
declare const DEFAULT_PANEL_TABLE: readonly ShapeRule[];
declare const DEFAULT_SONNET_FOR: Record<string, string>;
/** Placeholder weights until the scorecard reports measured spend per member. */
declare const DEFAULT_MEMBER_POINTS: {
    opus: number;
    sonnet: number;
};
/** No panel table: correctness alone, exactly as TP-1428 routes the single reviewer today. */
declare const DEFAULT_PANEL_POLICY: PanelPolicy;
/** The panel for one head: at most 3 members and 1 opus member. Spend is estimated, never capped. Pure. */
declare function planPanel(cls: PrClass, policy: PanelPolicy, headroom: Headroom): PanelPlan;

/** Why Shepherd could not verify this head's fix-proof; a head can force each of these, so none may pass on its own. */
type FixProofUnverified = "error" | "untrusted" | "unread";

/** CI's required checks already ran the full suite at this head; a reviewer rerunning them costs a host's memory and slots for no new signal. `gh api` is denied in reviewer sessions, so the read is `gh pr view`, which reports the PR's current head rather than this one. */
declare const CI_REVIEWER_TEST_RULE: string;
/** One check-run Shepherd read at the reviewed head; `status` and `conclusion` are GitHub's words, and `missing` is a required check with no run at the head. */
interface CiCheckRow {
    name: string;
    status: string;
    conclusion: string | null;
    required: boolean;
}
/** The most check-run rows a brief lists; a head with more is cut, never spilled into prose. */
declare const MAX_CI_CHECK_ROWS = 40;

type RepoSlug = string;
/** The most of a reviewer's OWNER-BRIEF block that is read; a longer block is malformed rather than cut. */
declare const MAX_OWNER_BRIEF_CHARS = 2000;
declare const OWNER_BRIEF_START = "OWNER-BRIEF";
declare const OWNER_BRIEF_END = "END-OWNER-BRIEF";
/** Why a reviewer's final message was no verdict: the parser refused its block, the block named another repo, PR or head, or a MERGE's CI-policy line was off-format. */
type MalformedRefusal = VerdictBlockRefusal | "wrong_target" | "ci_policy_malformed" | "probes_missing";
/** The name a reviewer extracts into: `review-<pr>-<first 12 hex of the head sha>`. */
declare function reviewCheckoutName(pr: number, head: string): string;
declare const MAX_REVIEWER_QUESTIONS = 8;
/** Shepherd's merge guard reads this line (TP-2407): a `.github/` change without it fails closed, and `weakened` reaches the owner. */
declare const CI_POLICY_RULE: string;

/** Everything a reviewer brief may carry; it has no field for task or implementer text, so none can reach the prompt. */
interface ReviewerBriefInput {
    repo: RepoSlug;
    pr: number;
    head: string;
    /** The absolute directory review checkouts live in; the brief puts this run's head and base checkouts under `<checkoutRoot>/<run>`. */
    checkoutRoot: string;
    /** Questions chosen by code for this diff, never text an implementer wrote. */
    questions?: readonly string[];
    /** FIX_FIRST reviews this PR already had in its run; one or more makes this a re-review. */
    fixFirsts?: number;
    /** True when this run's verdict will reach the owner; the brief then also asks for an OWNER-BRIEF block. */
    ownerBrief?: boolean;
    /** The reviewer test rule for the host serve runs on; absent means `CI_REVIEWER_TEST_RULE`, and `ciChecks` replaces it. */
    testRule?: string;
    /** The check-runs Shepherd read at this head; when set they replace `testRule`, so the reviewer judges CI from them and reads none itself. */
    ciChecks?: readonly CiCheckRow[];
    /** The raw `fix-proof/v1` result line; it is parsed and checked against the head, and only counts and the verdict reach the prompt. */
    fixProof?: string;
    /** Set by Shepherd when this head's fix-proof could not be verified; the brief then says the proof is blocking. */
    fixProofUnverified?: FixProofUnverified;
    /** The run's earlier FIX_FIRST findings, oldest first; reviewer text, so it is rendered as data with every verdict-block line removed. */
    earlierFindings?: readonly EarlierFinding[];
    /** Picks the owner recorded for this PR; only grammar-valid ones reach the prompt, so body text cannot. */
    ownerPicks?: readonly OwnerPick[];
    /** The absolute checkout git runs against with `-C`; set when the reviewer starts in its run dir rather than in the checkout. */
    sourceCheckout?: string;
}
/** One recorded owner answer: the question it settles and the choice the owner made. */
interface OwnerPick {
    id: string;
    choice: string;
}
/** One earlier FIX_FIRST of this run: the head it was given at, the class its reviewer named, and its findings. */
interface EarlierFinding {
    head: string;
    defectClass?: string;
    text: string;
}
/** The line the fixer's structural brief finds the reviewer's defect-class section by. */
declare const DEFECT_CLASS_HEADING = "Defect class:";
declare const MAX_OWNER_PICKS = 4;
/** Only picks a short plain grammar accepts are kept, since a caller may have read them from a PR body. */
declare function validOwnerPicks(picks: readonly OwnerPick[]): OwnerPick[];
declare const EARLIER_FINDINGS_START = "EARLIER-FINDINGS";
declare const EARLIER_FINDINGS_END = "END-EARLIER-FINDINGS";
/** The line a re-review's fixed/not-fixed checklist over the earlier findings starts with. */
declare const EARLIER_FINDINGS_HEADING = "Earlier findings:";
/** Lets a reviewer defer a nit to a task instead of a FIX_FIRST round; the template's placeholders never parse as an item. */
declare const FOLLOW_UPS_RULE: string;
/** The closing block is a template with a placeholder verdict, so the brief itself never parses as a verdict. */
declare function reviewerBrief(input: ReviewerBriefInput): string;
/** The most a correction prompt may hold, owner block included; raised from 1500 for the CI-policy exactness sentence, then from 1600 for the adversary's Probes sentence. */
declare const MAX_CORRECTION_PROMPT_CHARS = 1700;
/** One fixed sentence per refusal; a closed map, so no reviewer text can reach the prompt. */
declare const REFUSAL_SENTENCES: Record<MalformedRefusal, string>;
interface CorrectionPromptInput {
    repo: RepoSlug;
    pr: number;
    head: string;
    refusal: MalformedRefusal;
    /** True when this run's verdict will reach the owner, as for the review brief. */
    ownerBrief?: boolean;
}
/** Built only from code-chosen strings, since it travels in argv; the verdict line is a placeholder, so it never parses as a verdict. */
declare function correctionPrompt(input: CorrectionPromptInput): string;

declare const FOLLOW_UPS_HEADING = "Follow-ups:";
declare const MAX_FOLLOW_UPS = 5;
declare const MAX_FOLLOW_UP_TITLE_CHARS = 120;
declare const MAX_FOLLOW_UP_DONE_WHEN_CHARS = 400;
/** No `critical`: anything that serious belongs in a FIX_FIRST, not in work deferred past the merge. */
declare const FOLLOW_UP_SEVERITIES: readonly ["low", "medium", "high"];
/** One task a reviewer proposes for later; it never decides the verdict. */
declare const FollowUpSchema: z.ZodObject<{
    title: z.ZodString;
    doneWhen: z.ZodString;
    severity: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>;
}, z.core.$strict>;
type FollowUp = z.infer<typeof FollowUpSchema>;
declare const FOLLOW_UPS_WARNINGS: readonly ["multiple_blocks", "bad_item", "bad_severity", "too_many", "too_long", "placeholder"];
/** Why a Follow-ups block was dropped whole; a closed set, so no reviewer text travels with it. */
type FollowUpsWarning = (typeof FOLLOW_UPS_WARNINGS)[number];
interface ParsedFollowUps {
    items: FollowUp[];
    warning?: FollowUpsWarning;
}
/**
 * The one `Follow-ups:` block anywhere in a reviewer's visible text, before or after the verdict lines. Any fault drops the
 * whole block with one named warning rather than filing part of it, and nothing here can change the verdict.
 */
declare function parseFollowUps(text: string): ParsedFollowUps;
/** The fields an accepted verdict carries: both absent when the reviewer proposed nothing and wrote nothing malformed. */
declare function followUpsFields(text: string): {
    followUps?: FollowUp[];
    followUpsWarning?: FollowUpsWarning;
};

/** What the owner is asked about a gated PR, as the reviewer who read the diff wrote it. */
declare const OwnerBriefSchema: z.ZodObject<{
    what: z.ZodString;
    why: z.ZodString;
    pros: z.ZodArray<z.ZodString>;
    cons: z.ZodArray<z.ZodString>;
    doorType: z.ZodEnum<{
        "two-way": "two-way";
        "one-way": "one-way";
    }>;
}, z.core.$strict>;
type OwnerBrief = z.infer<typeof OwnerBriefSchema>;
/**
 * The one OWNER-BRIEF block after the verdict line, or null when there is none or it is malformed, too long or has
 * a door type other than two-way or one-way. Only the parsed fields are returned, never the surrounding text.
 */
declare function parseOwnerBrief(text: string): OwnerBrief | null;
/** Keyed by the closed union, so a refusal the parser adds fails to compile here until it is listed. */
declare const MALFORMED_REFUSALS: Record<MalformedRefusal, true>;
declare const MalformedSchema: z.ZodObject<{
    refusal: z.ZodString & z.ZodType<MalformedRefusal, string, z.core.$ZodTypeInternals<MalformedRefusal, string>>;
    writtenAt: z.ZodNumber;
}, z.core.$strip>;
/** The record `acceptVerdict` leaves on a `none` whose final message was malformed; `writtenAt` is that message's time. */
type Malformed = z.infer<typeof MalformedSchema>;
/** The `malformed` record in a stored await output, or null for any output without a valid one. */
declare function readMalformed(output: unknown): Malformed | null;

interface AcceptedVerdict {
    kind: "verdict";
    head: string;
    locator: SourceTextLocator;
    /** The author of the accepted message, as the reader attributed it. */
    reviewer: {
        agentId: string;
        sessionId: string;
    };
    /** The reviewer's OWNER-BRIEF block, or null when it wrote none or it did not parse; never read by the verdict. */
    ownerBrief?: OwnerBrief | null;
    /** Tasks the reviewer proposed for later, on MERGE and FIX_FIRST alike; never read by the verdict. */
    followUps?: FollowUp[];
    /** Why the reviewer's Follow-ups block was dropped whole; the verdict still counts. */
    followUpsWarning?: FollowUpsWarning;
    /** The profile the accepted message's author was spawned with; absent when neither the dispatch nor the roster says. */
    reviewerProfile?: string;
}
/** Only a FIX_FIRST keeps the reviewer's words, because the implementer has to read them; only a MERGE carries the CI-policy line, and only an unchanged or weakened one. */
type AwaitVerdictResult = (AcceptedVerdict & {
    verdict: "MERGE";
    ciPolicy?: CiPolicy;
}) | (AcceptedVerdict & {
    verdict: "FIX_FIRST";
    text: string;
    closer?: "yes" | "no";
}) | {
    kind: "none";
    reason?: string;
    notice?: string;
    resetsAt?: number;
};
/** Why a final message was no verdict: the account's usage limit ended the reviewer's turn, so asking again is pointless until it resets. */
declare const USAGE_LIMIT_REASON = "the reviewer hit the account usage limit and wrote no review";
/** A usage-limit result keeps the notice, whose reset time decides how long the account is held. */
declare const isUsageLimit: (result: {
    kind: string;
    reason?: unknown;
    notice?: unknown;
}) => boolean;
/**
 * Accepts only the final message of the dispatched agent and session, written after dispatch, whose block names this PR at
 * this head. The reader's fields are not trusted: the locator must point into the dispatched session too, and no message
 * in the read may be written after the final one, so the latest message decides whatever order the reader gave.
 * A final message that passes those checks but whose block is refused, or names another repo, PR or head, is `none` with a
 * `malformed` record; silence, a foreign or earlier message, `WAIT` and the client's own usage-limit notice (which no correction can answer) carry none. A MERGE or FIX_FIRST from a session that
 * made no investigative call is `none` with the depth-floor reason; a message the reader did not count is judged as before.
 * A MERGE whose CI-policy line reads malformed is refused for one correction; a weakened reading wins over malformed in the
 * parser, so a weakening is never corrected away. An adversary verdict with no `Probes:` line is refused for one correction too.
 */
declare function acceptVerdict(input: AwaitVerdictInput, messages: readonly ReviewerMessage[]): AwaitVerdictResult;

/** The closed set of read families that show a reviewer looked at the change: file reads and searches, and Bash read verbs. */
declare const INVESTIGATIVE_CALLS: {
    readonly tools: readonly ["Read", "Grep", "Glob"];
    readonly bashVerbs: readonly ["git log", "git show", "git diff", "git grep", "gh pr view", "gh pr diff", "gh pr checks", "cat", "sed -n", "rg", "npx vitest", "grep", "head", "tail", "wc", "git ls-files", "git merge-tree", "pnpm exec vitest", "pnpm vitest", "npm run verify", "npm test", "node --test"];
};
/** Why a parsed MERGE or FIX_FIRST was set aside: nothing in the reviewer's own session read the change first. */
declare const DEPTH_FLOOR_REASON = "below the review depth floor: the reviewer made no investigative tool call before its verdict";
/** A Read, Grep or Glob call, or a Bash call in which some `&&`, `||`, `;` or newline separated pipeline starts with a read verb, made in this conversation rather than copied in. */
declare function isInvestigativeCall(observation: NormalizedSessionObservation): boolean;

/** The most of a FIX_FIRST's findings the step output keeps, marker included. */
declare const MAX_FIX_FIRST_TEXT_CHARS = 16000;
/** Leads findings cut to the cap; the newest findings sit at the end, so the start is what goes. */
declare const FIX_FIRST_TRUNCATED = "[earlier findings truncated]\n";
/** Separates two of the reviewer's FIX_FIRST messages in the findings the fixer is handed. */
declare const FINDINGS_SEPARATOR = "\n\n---\n\n";
declare const BLOCK_LINE: RegExp;
/** What a verdict message says beside its block; empty when it is the block alone. */
declare const findingsText: (text: string) => string;
declare function boundedFindings(text: string, max?: number): string;
/**
 * The findings a fixer is handed for a FIX_FIRST at this head: every FIX_FIRST naming it that says something beside its block,
 * oldest first and without repeats, cut from the start so the newest survive. A reviewer can restate the block under a
 * postscript, or under a fuller list once a background task ends, so no one message stands for the rest. Callers pass only
 * messages their agent, session and dispatch guards let through; `fallback` is the verdict message, used when none says more.
 */
declare function fixFirstFindings(target: ReviewTarget, messages: readonly ReviewerMessage[], fallback: string, heading?: string): string;
/** The line a reviewer lists, as its own blocking item, when it could not read CI at this head; Shepherd re-reviews a FIX_FIRST holding only it. */
declare const CI_UNREAD_LINE = "Blocking: CI unread";
/**
 * True when a FIX_FIRST's only blocking item is the CI-unread line: the exact line, bare or as a list item, and no other list
 * item before the defect-class section. Anything else a reviewer listed may be a real finding, so it keeps the FIX_FIRST.
 */
declare function ciUnreadOnly(text: string): boolean;
/** The line a reviewer adds for each blocking item that contradicts a recorded owner pick. */
declare const OWNER_PICK_CONTRADICTED = "Owner pick contradicted:";
/** The recorded pick ids a reviewer's text names on contradiction lines, each once; an id not recorded is ignored. */
declare function contradictedPicks(text: string, ids: readonly string[]): string[];

/** A verdict block names its target when repo (GitHub ignores case), PR number and head sha all match. */
declare function namesTarget(block: {
    repo: string;
    pr: number;
    head: string;
}, target: {
    repo: string;
    pr: number;
    head: string;
}): boolean;
/** The same rule without the head: a block names the PR at any head. */
declare function namesPr(block: {
    repo: string;
    pr: number;
}, target: {
    repo: string;
    pr: number;
}): boolean;

/** One member's result: its accepted verdict, `none` when it gave none after its fresh retry, or `timeout`. */
interface MemberResult {
    shape: ReviewShape;
    result: AwaitVerdictResult | {
        kind: "timeout";
    };
    /** Retried at sonnet because opus was refused at spawn. */
    degraded?: boolean;
}
interface AggregateInput {
    /** The head every counted verdict must name. */
    head: string;
    /** File text at the head; advisory findings whose citations it cannot confirm are dropped. */
    source: LineSource;
    /**
     * fix-proof's verdict word or its `fix-proof/v1` line, when one ran. `vacuous`, `no-tests`, `error`, `unproven`, a
     * line naming another head, or anything unreadable makes the tests member blocking. A bare word never satisfies G10;
     * only a line pinned to the head can.
     */
    fixProof?: string;
    /** The opus profiles, as `planPanel`'s policy lists them; satisfiesG10 needs the correctness member at one. */
    sonnetFor?: Record<string, string>;
}
/** The panel verdict for one head from its members' results. Every path it cannot classify ends short of MERGE. Pure. */
declare function aggregate(plan: PanelPlan, results: readonly MemberResult[], input: AggregateInput): PanelVerdict;

/** The line an adversary verdict must carry above its block; a verdict without it is malformed. */
declare const PROBES_HEADING = "Probes:";
/** Why a hold asked for an adversary, as the host knows it; every field is text other agents wrote, so it is rendered as data. */
interface AdversaryHoldContext {
    holdReason?: string;
    matchedFiles?: readonly string[];
    doneWhen?: string;
    lastReport?: string;
}
/** A line starting `Probes:` above the verdict block. */
declare function hasProbesLine(text: string): boolean;

/** The shapes that carry an overlay; correctness is the base brief itself. */
type OverlayShape = Exclude<ReviewShape, "correctness">;
declare const OVERLAY_SHAPES: readonly OverlayShape[];
interface ShapeBrief {
    /** Stable across edits; `hash` names the variant. */
    id: string;
    shape: OverlayShape;
    overlay: string;
    /** sha256 of `overlay`, so an edited brief is a new variant rather than an in-place change. */
    hash: string;
}
/** Ids match `planPanel`'s default brief id per shape. */
declare const SHAPE_BRIEFS: Readonly<Record<OverlayShape, ShapeBrief>>;
interface ShapeBriefInput extends ReviewerBriefInput {
    /** A `fix-proof/v1 <json>` line for this head; only the tests brief reads it. */
    fixProof?: string;
    /** Why the PR is held for an adversary; only the adversary brief reads it. */
    holdContext?: AdversaryHoldContext;
}
/** The overlay comes first so the base brief's verdict template stays the end of the prompt. */
declare function shapeBrief(shape: OverlayShape, input: ShapeBriefInput): string;

interface ReviewRequest {
    facts: PrFacts;
    /** Everything the briefs carry except the target, which `facts` names. */
    brief: Omit<ShapeBriefInput, "repo" | "pr" | "head">;
    /** File text at the head, for the aggregate's citation check. */
    source: LineSource;
    /** Absent means `DEFAULT_PANEL_POLICY`. */
    policy?: PanelPolicy;
    /** Absent means `DEFAULT_CLASS_RULES`. */
    rules?: ClassRules;
}
interface ReviewClock {
    now(): number;
    sleep(ms: number): Promise<void>;
}
interface ReviewPorts {
    dispatch: ReviewerDispatch;
    reader: ReviewerReader;
    clock: ReviewClock;
    /** Asked once, before planning. */
    headroom(): Promise<Headroom>;
}
interface ReviewOptions {
    pollMs?: number;
    /** How long a member's session may take to start, from its spawn. */
    startDeadlineMs?: number;
    /** How long a started member may take to write its verdict. */
    verdictDeadlineMs?: number;
}
/** Why a member has no verdict when the dispatch refused it at its profile and at any sonnet fallback. */
declare const SPAWN_REFUSED_REASON = "the dispatch refused to spawn the reviewer";
/** A pure function of the input, so a repeat call finds the same roster row; attempt 2 is the fresh retry of a silent member. */
declare function memberName(target: ReviewTarget, shape: ReviewShape, attempt?: 1 | 2): string;
/**
 * Classifies, plans, runs every member in parallel and aggregates. Each member is spawned under `memberName`, so a repeat
 * call with the same input reuses the roster rows and spawns nothing.
 */
declare function reviewPullRequest(request: ReviewRequest, ports: ReviewPorts, opts?: ReviewOptions): Promise<PanelVerdict>;

export { type AcceptedVerdict, type AdversaryHoldContext, type AggregateInput, type AwaitVerdictInput, type AwaitVerdictResult, BLOCK_LINE, CI_POLICY_RULE, CI_REVIEWER_TEST_RULE, CI_UNREAD_LINE, type ChangedFile, type CiCheckRow, type ClassRoles, type ClassRules, DEFAULT_CLASS_ROLES, DEFAULT_CLASS_RULES, DEFAULT_MEMBER_POINTS, DEFAULT_PANEL_POLICY, DEFAULT_PANEL_TABLE, DEFAULT_SHAPE_ROLES, DEFAULT_SONNET_FOR, DEFECT_CLASS_HEADING, DEPTH_FLOOR_REASON, EARLIER_FINDINGS_END, EARLIER_FINDINGS_HEADING, EARLIER_FINDINGS_START, type EarlierFinding, FINDINGS_SEPARATOR, FIX_FIRST_TRUNCATED, FOLLOW_UPS_HEADING, FOLLOW_UPS_RULE, FOLLOW_UPS_WARNINGS, FOLLOW_UP_SEVERITIES, type FixProofUnverified, type FollowUp, FollowUpSchema, type FollowUpsWarning, type Headroom, INVESTIGATIVE_CALLS, MALFORMED_REFUSALS, MAX_CI_CHECK_ROWS, MAX_CORRECTION_PROMPT_CHARS, MAX_FIX_FIRST_TEXT_CHARS, MAX_FOLLOW_UPS, MAX_FOLLOW_UP_DONE_WHEN_CHARS, MAX_FOLLOW_UP_TITLE_CHARS, MAX_OWNER_BRIEF_CHARS, MAX_OWNER_PICKS, MAX_REVIEWER_QUESTIONS, type Malformed, type MalformedRefusal, MalformedSchema, type MemberResult, OVERLAY_SHAPES, OWNER_BRIEF_END, OWNER_BRIEF_START, OWNER_PICK_CONTRADICTED, type OverlayShape, type OwnerBrief, OwnerBriefSchema, type OwnerPick, PROBES_HEADING, type PanelFinding, type PanelMember, type PanelOutcome, type PanelPlan, type PanelPolicy, type PanelVerdict, type ParsedFollowUps, type PrClass, type PrFacts, type PrTouch, type Presence, REFUSAL_SENTENCES, type ReviewClass, type ReviewClock, type ReviewOptions, type ReviewPorts, type ReviewRequest, type ReviewShape, type ReviewTarget, type ReviewerAgent, type ReviewerBriefInput, type ReviewerDispatch, type ReviewerFacts, type ReviewerMessage, type ReviewerReader, SECURITY_SLICE_LINES, SHAPE_BRIEFS, SPAWN_REFUSED_REASON, type ShapeBrief, type ShapeBriefInput, type ShapeRule, type SliceFlag, type SliceInput, USAGE_LIMIT_REASON, acceptVerdict, aggregate, boundedFindings, changedLineCount, ciUnreadOnly, classifyPr, contradictedPicks, correctionPrompt, findingsText, fixFirstFindings, followUpsFields, hasProbesLine, isInvestigativeCall, isUsageLimit, memberName, namesPr, namesTarget, parseFollowUps, parseOwnerBrief, pathTouches, planPanel, readMalformed, reviewCheckoutName, reviewPullRequest, reviewerBrief, securitySliceFlag, shapeBrief, touchesDependency, validOwnerPicks };

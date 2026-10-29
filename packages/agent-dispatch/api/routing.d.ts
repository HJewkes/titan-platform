import { P as PriorRouting, W as WorkflowTable, T as TaskFacts } from '../prior.js';
export { C as CLASSES, a as Classified, D as DISPATCHABLE, I as IMPLEMENTER_LADDER, b as Implementer, M as MERGE_LADDER, c as PATH_LISTS, d as PLAN_LADDER, e as PRIORS, f as PRIOR_ROUTINGS, g as PathList, h as PlanFacts, i as Prior, j as PriorRouter, k as PriorRule, l as Profile, R as REVIEW_LADDER, m as Routed, S as ShapeClass, n as TABLE_VERSION, o as TableRead, p as WorkflowRow, q as classifyTask, r as parseWorkflowTable, s as planFacts, t as priorRoute, u as profileFor, v as unitsOf } from '../prior.js';

/**
 * The `route_*` keys a dispatcher writes on its spawn row, defined once so the writer, the readout and the outcome
 * join cannot drift. The chosen profile is not here: it is the row's own `profile`.
 */
declare const ROUTE_META_KEYS: readonly ["route_mode", "route_source", "route_prior", "route_reason", "route_requested", "route_wanted", "route_workflow", "route_table", "route_facts", "route_candidate", "route_candidate_wanted"];
type RouteMetaKey = (typeof ROUTE_META_KEYS)[number];
declare const FACT_SOURCES: readonly ["plan-slice", "plan", "req", "none"];
type FactSource = (typeof FACT_SOURCES)[number];
declare const FACT_NAMES: readonly ["estimate", "done_when", "kind", "owns", "slice"];
type FactName = (typeof FACT_NAMES)[number];
/** Which facts a decision saw and where its owns came from, so the readout can measure fact coverage. */
interface FactsNote {
    source: FactSource;
    present: FactName[];
    /** The task id was found in more than one initiative; the first was read. */
    ambiguous?: true;
}
declare const ROUTE_SOURCES: readonly ["auto", "routed", "agrees", "shadow", "override", "keep-role", "no-task", "table-error"];
type RouteSource = (typeof ROUTE_SOURCES)[number];
interface RouteDecision {
    mode: "off" | "shadow" | "on";
    source: RouteSource;
    /** The profile that runs. */
    profile: string;
    requested: string;
    prior?: string;
    reason?: string;
    /** The table's own pick, even when it is outside the tiers and so never applied. */
    wanted?: string;
    /** The class row the prior sent the task to. */
    workflow?: string;
    table?: string;
    facts?: FactsNote;
    candidate?: string;
    candidateWanted?: string;
    /** One line for the dispatcher's log when the decision changed, or would change, the profile. */
    note?: string;
}
/** The decision as `route_*` string fields; absent parts are left out rather than written empty. */
declare function routeMeta(decision: RouteDecision): Partial<Record<RouteMetaKey, string>>;

/**
 * The spawn-time route: which implementer profile a spawn runs as, decided from the workflow table. Pure. Routing
 * picks a profile and never refuses: a missing table, missing facts or a pick outside the tiers keeps the request.
 */
declare const AUTO_PROFILE = "auto";
/** The profile `auto` runs as whenever the table cannot place it. */
declare const AUTO_FALLBACK = "bd-implementer";
/** Fix rounds stay on the profile they asked for: they are logged, never routed. */
declare const DEFAULT_KEEP_ROLES: readonly string[];
/** A linted table and its id for the decision log, such as `shape-v1@1a2b3c4d`. */
interface RouteTable {
    table: WorkflowTable;
    id: string;
}
interface RouteInput {
    mode: PriorRouting;
    requested: string;
    /** Undefined when the table could not be read or failed its lint; `tableProblem` says why. */
    table: RouteTable | undefined;
    tableProblem?: string;
    taskId?: string;
    role?: string;
    keepRoles?: readonly string[];
    override?: string;
    facts?: TaskFacts;
    factsNote?: FactsNote;
    /** A table evaluated beside the live one; its pick is recorded and never applied. */
    candidate?: RouteTable;
}
declare const FAMILIES: readonly ["bd-", ""];
type ImplementerFamily = (typeof FAMILIES)[number];
/** The family a requested profile belongs to, or undefined for a profile the router leaves alone. */
declare function implementerFamily(profile: string): ImplementerFamily | undefined;
/** The table's pick at the caller's family, so `implementer` can become `implementer-lite` but never a bd profile. */
declare function inFamily(wanted: string, family: ImplementerFamily): string | undefined;
/**
 * The decision for one spawn, or undefined when the spawn is not routed: a profile outside the implementer family,
 * an explicit profile with routing off, or an explicit profile with no task. `auto` is the caller's own request to
 * route, so it classifies in every mode.
 */
declare function routeSpawn(input: RouteInput): RouteDecision | undefined;

/**
 * The shadow readout over logged spawn rows: how often the table agrees with what dispatchers asked for, how often it
 * would route down, and how many decisions had the facts to route at all. Pure; the caller reads the rows.
 */
/** One spawn row's meta, as the dispatcher logged it; rows with no `route_source` are ignored. */
type RouteRow = Readonly<Record<string, unknown>>;
interface RouteSummary {
    decisions: number;
    bySource: Partial<Record<RouteSource, number>>;
    /** Agreement among decisions the table could have changed; keep-role, override, auto and errors are left out. */
    agreement: {
        agree: number;
        of: number;
    };
    /** Shadow decisions whose table pick was the lite tier. */
    wouldLite: number;
    /** Decisions that picked lite with no owns known; the gate to `on` needs this at 0. */
    liteWithoutOwns: number;
    /** Decisions whose facts had both an estimate and owns. */
    factCoverage: {
        covered: number;
        of: number;
    };
    /** Decisions where a candidate table was evaluated, and how many picked differently from the live one. */
    candidate: {
        differs: number;
        of: number;
    };
}
declare function summarizeRoutes(rows: readonly RouteRow[]): RouteSummary;

export { AUTO_FALLBACK, AUTO_PROFILE, DEFAULT_KEEP_ROLES, FACT_NAMES, FACT_SOURCES, type FactName, type FactSource, type FactsNote, type ImplementerFamily, PriorRouting, ROUTE_META_KEYS, ROUTE_SOURCES, type RouteDecision, type RouteInput, type RouteMetaKey, type RouteRow, type RouteSource, type RouteSummary, type RouteTable, TaskFacts, WorkflowTable, implementerFamily, inFamily, routeMeta, routeSpawn, summarizeRoutes };

// ./dist/prior.d.ts
/**
 * The workflow table as data, and its lint. Every value is a closed enum, so a typo is a lint problem rather than a
 * row that silently matches nothing. Pure: the caller reads the file (`./routing/node` does).
 */
declare const TABLE_VERSION = "shape-v1";
declare const CLASSES: readonly ["generated", "release", "one-way", "safety-path", "ui-round", "agent-text", "inert", "mechanical", "local-fix", "cross-package", "feature-slice"];
type ShapeClass = (typeof CLASSES)[number];
declare const PRIORS: readonly ["one-way", "safety-path", "ui-round", "cross-package", "agent-text", "small", "standard", "needs-plan"];
type Prior = (typeof PRIORS)[number];
declare const PLAN_LADDER: readonly ["none", "explore", "bd-planner", "fable-architect", "titan-component-workflow"];
declare const IMPLEMENTER_LADDER: readonly ["code", "bd-implementer-lite", "bd-implementer", "fable-implementer"];
declare const REVIEW_LADDER: readonly ["ci", "reviewer", "bd-reviewer", "fable-reviewer", "fable-reviewer+owner"];
declare const MERGE_LADDER: readonly ["MRG-AU-CI", "MRG-AU-RV", "owner", "release-path"];
declare const PATH_LISTS: readonly ["door", "safety", "visual", "agentText"];
type Implementer = (typeof IMPLEMENTER_LADDER)[number];
type Profile = Implementer | "bd-planner";
type PathList = (typeof PATH_LISTS)[number];
interface PriorRule {
    prior: Prior;
    owns?: PathList;
    ownsOnly?: PathList;
    unitsAtLeast?: number;
    tags?: string[];
    estimateAtMost?: number;
    needsDoneWhen?: boolean;
    needsOwns?: boolean;
}
interface WorkflowRow {
    plan: (typeof PLAN_LADDER)[number];
    planAbove2?: (typeof PLAN_LADDER)[number];
    implementer: Implementer;
    implementerAbove2?: Implementer;
    review: (typeof REVIEW_LADDER)[number];
    merge: (typeof MERGE_LADDER)[number];
}
interface WorkflowTable {
    version: typeof TABLE_VERSION;
    priors: PriorRule[];
    paths: Record<PathList, string[]>;
    workflow: Record<ShapeClass, WorkflowRow>;
    /** Which class row gives a prior its implementer; `planner` sends it to `bd-planner`. */
    priorWorkflow: Record<Prior, ShapeClass | "planner">;
}
type TableRead = {
    table: WorkflowTable;
    problems?: undefined;
} | {
    table?: undefined;
    problems: string[];
};
/** The table, or one reason line per problem. */
declare function parseWorkflowTable(text: string): TableRead;

/**
 * The task-time prior and the implementer profile the workflow table gives it. Pure: the same facts give the same
 * prior and reason. Rules run in the table's order and the first match wins, so a risk row (paths, tags) beats a size
 * row however small the estimate.
 */
interface TaskFacts {
    estimate?: number | null;
    done_when?: string | null;
    tags?: readonly string[] | null;
    /** The union of the plan's slice `owns`, repo-relative; empty without a plan. */
    owns: readonly string[];
}
interface Classified {
    prior: Prior;
    reason: string;
}
/** The distinct units the paths touch; test and ignored paths, and paths outside a unit, count for none. */
declare function unitsOf(owns: readonly string[]): string[];
declare function classifyTask(table: WorkflowTable, facts: TaskFacts): Classified;
/** The profile the prior's class row dispatches at this estimate; an unknown estimate takes the larger rung. */
declare function profileFor(table: WorkflowTable, prior: Prior, estimate: number | null | undefined): Profile;

/**
 * The implementer profile a task-time prior gives a dispatch. `off` reads nothing; `shadow` keeps today's profile
 * and notes the change `on` would make; `on` routes by the prior.
 */
declare const PRIOR_ROUTINGS: readonly ["off", "shadow", "on"];
type PriorRouting = (typeof PRIOR_ROUTINGS)[number];
interface PriorRouter {
    mode: Exclude<PriorRouting, "off">;
    table: WorkflowTable;
}
interface Routed {
    profile: string;
    note?: string;
}
/** The profiles a dispatcher can spawn as an implementer; a prior naming any other keeps today's. */
declare const DISPATCHABLE: readonly string[];
/** The profile for a dispatch whose route today gives `today`, and the note when the prior would change it. */
declare function priorRoute(router: PriorRouter, facts: TaskFacts, today: string, label: string): Routed;
interface PlanFacts {
    owns: string[];
    points?: number;
}
/** The union of the plan's slice owns, or the named slice's owns and points; empty with no plan or a failing one. */
declare function planFacts(planText: string | undefined, slice?: string): PlanFacts;

export { CLASSES as C, DISPATCHABLE as D, IMPLEMENTER_LADDER as I, MERGE_LADDER as M, type PriorRouting as P, REVIEW_LADDER as R, type ShapeClass as S, type TaskFacts as T, type WorkflowTable as W, type Classified as a, type Implementer as b, PATH_LISTS as c, PLAN_LADDER as d, PRIORS as e, PRIOR_ROUTINGS as f, type PathList as g, type PlanFacts as h, type Prior as i, type PriorRouter as j, type PriorRule as k, type Profile as l, type Routed as m, TABLE_VERSION as n, type TableRead as o, type WorkflowRow as p, classifyTask as q, parseWorkflowTable as r, planFacts as s, priorRoute as t, profileFor as u, unitsOf as v };

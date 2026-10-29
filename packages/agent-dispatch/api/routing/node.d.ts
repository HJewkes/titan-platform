import { z as RouteTable, G as TaskFacts, g as FactsNote, q as PriorRouting, p as PriorRouter, E as TableRead } from '../route.js';

/** The `shape-v1.yml` this package ships, with `needsOwns` on the size rows. */
declare const DEFAULT_WORKFLOW_TABLE: string;
declare const workflowTablePath: (autonomyRoot: string) => string;
/** `<autonomyRoot>/workflow/shape-v1.yml`, linted; undefined when the file is absent. */
declare function readWorkflowTable(autonomyRoot: string): TableRead | undefined;
/** The router for `mode`, or the one note saying why the dispatch routes as today; `off` touches no file. */
declare function readPriorRouter(mode: PriorRouting, autonomyRoot: string): {
    router?: PriorRouter;
    note?: string;
};
type RouteTableRead = {
    table: RouteTable;
    problem?: undefined;
} | {
    table?: undefined;
    problem: string;
};
/**
 * The table at `file` with its `shape-v1@<sha8>` id for the decision log. A spawn path calls this per spawn, so the
 * file is re-read and re-linted only when its mtime or size changes.
 */
declare function readRouteTable(file: string): RouteTableRead;
interface SpawnFacts {
    facts: TaskFacts;
    note: FactsNote;
}
/**
 * The facts a spawn routes on, read from the active-work root: estimate, done_when and tags from the task file, and
 * owns from `sources/<taskId>-plan.md`. With a slice, that slice's owns and points (as the estimate); without one,
 * the union of owns and the task estimate; with no plan owns, the spawn's own `reqOwns`.
 */
declare function readSpawnFacts(root: string, taskId: string, slice?: string, reqOwns?: readonly string[]): SpawnFacts;

export { DEFAULT_WORKFLOW_TABLE, type RouteTableRead, type SpawnFacts, readPriorRouter, readRouteTable, readSpawnFacts, readWorkflowTable, workflowTablePath };

// ./dist/route.d.ts
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

export { AUTO_FALLBACK as A, type Routed as B, CLASSES as C, DEFAULT_KEEP_ROLES as D, type TableRead as E, FACT_NAMES as F, type TaskFacts as G, type WorkflowTable as H, IMPLEMENTER_LADDER as I, classifyTask as J, implementerFamily as K, inFamily as L, MERGE_LADDER as M, parseWorkflowTable as N, planFacts as O, PATH_LISTS as P, priorRoute as Q, type RouteSource as R, type ShapeClass as S, TABLE_VERSION as T, profileFor as U, routeMeta as V, type WorkflowRow as W, routeSpawn as X, unitsOf as Y, AUTO_PROFILE as a, type Classified as b, DISPATCHABLE as c, FACT_SOURCES as d, type FactName as e, type FactSource as f, type FactsNote as g, type Implementer as h, type ImplementerFamily as i, PLAN_LADDER as j, PRIORS as k, PRIOR_ROUTINGS as l, type PathList as m, type PlanFacts as n, type Prior as o, type PriorRouter as p, type PriorRouting as q, type PriorRule as r, type Profile as s, REVIEW_LADDER as t, ROUTE_META_KEYS as u, ROUTE_SOURCES as v, type RouteDecision as w, type RouteInput as x, type RouteMetaKey as y, type RouteTable as z };

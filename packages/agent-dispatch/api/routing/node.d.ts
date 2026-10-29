import { P as PriorRouting, j as PriorRouter, o as TableRead } from '../prior.js';

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

export { DEFAULT_WORKFLOW_TABLE, readPriorRouter, readWorkflowTable, workflowTablePath };

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

import { z } from 'zod';

/**
 * The agent roster and agent graph as a console reads them from the agent-chat
 * broker. Live presence (`/api/sessions`) knows only working, available and
 * blocked; every other state comes from the lifecycle rows in `/api/history`,
 * and `stateSource` says which of the two a row's state was read from.
 */
/** One row of the broker's event log as `/api/history` projects it. `kind` stays a string so new kinds parse. */
declare const brokerEvent: z.ZodObject<{
    msgId: z.ZodString;
    kind: z.ZodString;
    from: z.ZodString;
    text: z.ZodString;
    at: z.ZodNumber;
    meta: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$strip>;
type BrokerEvent = z.infer<typeof brokerEvent>;
/** Presence statuses, verbatim from the broker's registry. */
declare const PRESENCE_STATES: readonly ["working", "available", "blocked"];
/** The fields of one `/api/sessions` row the roster reads; unknown fields pass through untouched. */
declare const brokerSession: z.ZodObject<{
    name: z.ZodString;
    workingOn: z.ZodString;
    cwd: z.ZodString;
    status: z.ZodEnum<{
        working: "working";
        available: "available";
        blocked: "blocked";
    }>;
    idleMs: z.ZodNumber;
    registeredAt: z.ZodNumber;
    dnd: z.ZodOptional<z.ZodBoolean>;
    provisional: z.ZodOptional<z.ZodBoolean>;
    tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
        tag: z.ZodString;
    }, z.core.$strip>>>;
    observed: z.ZodOptional<z.ZodObject<{
        gitBranch: z.ZodOptional<z.ZodString>;
        claudeSessionId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    declared: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
type BrokerSession = z.infer<typeof brokerSession>;
declare const brokerSessions: z.ZodObject<{
    sessions: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        workingOn: z.ZodString;
        cwd: z.ZodString;
        status: z.ZodEnum<{
            working: "working";
            available: "available";
            blocked: "blocked";
        }>;
        idleMs: z.ZodNumber;
        registeredAt: z.ZodNumber;
        dnd: z.ZodOptional<z.ZodBoolean>;
        provisional: z.ZodOptional<z.ZodBoolean>;
        tags: z.ZodOptional<z.ZodArray<z.ZodObject<{
            tag: z.ZodString;
        }, z.core.$strip>>>;
        observed: z.ZodOptional<z.ZodObject<{
            gitBranch: z.ZodOptional<z.ZodString>;
            claudeSessionId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        declared: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>>;
    brokerUptimeMs: z.ZodNumber;
}, z.core.$strip>;
declare const brokerHistory: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        msgId: z.ZodString;
        kind: z.ZodString;
        from: z.ZodString;
        text: z.ZodString;
        at: z.ZodNumber;
        meta: z.ZodRecord<z.ZodString, z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** Lifecycle states folded from history for an agent with no live presence. `failed` is an exit that never started. */
declare const HISTORY_STATES: readonly ["spawning", "detached", "exited", "failed", "retired"];
/** History states whose process may still be running; the rest are past. */
declare const LIVE_HISTORY_STATES: readonly ["spawning", "detached"];
declare const agentState: z.ZodEnum<{
    working: "working";
    available: "available";
    blocked: "blocked";
    spawning: "spawning";
    detached: "detached";
    exited: "exited";
    failed: "failed";
    retired: "retired";
}>;
type AgentState = z.infer<typeof agentState>;
declare const agentStateSource: z.ZodEnum<{
    presence: "presence";
    history: "history";
}>;
type AgentStateSource = z.infer<typeof agentStateSource>;
/** `claudeSessionId` when Claude Code started the session, else `name@registeredAt` (spawn time for a history-only row). */
declare const agentIdSource: z.ZodEnum<{
    claudeSessionId: "claudeSessionId";
    nameAtRegisteredAt: "nameAtRegisteredAt";
}>;
type AgentIdSource = z.infer<typeof agentIdSource>;
/** `spawned` by the supervisor, `adopted` when a human-started session registered, `unknown` when no spawn row is in the window. */
declare const agentOrigin: z.ZodEnum<{
    unknown: "unknown";
    spawned: "spawned";
    adopted: "adopted";
}>;
type AgentOrigin = z.infer<typeof agentOrigin>;
/** `session-analytics` prices the transcript; `exit-report` is the cost the agent's own exit row carried. */
declare const agentCostSource: z.ZodEnum<{
    "session-analytics": "session-analytics";
    "exit-report": "exit-report";
}>;
type AgentCostSource = z.infer<typeof agentCostSource>;
declare const agentRosterEntry: z.ZodObject<{
    id: z.ZodString;
    idSource: z.ZodEnum<{
        claudeSessionId: "claudeSessionId";
        nameAtRegisteredAt: "nameAtRegisteredAt";
    }>;
    name: z.ZodString;
    agentId: z.ZodNullable<z.ZodString>;
    state: z.ZodEnum<{
        working: "working";
        available: "available";
        blocked: "blocked";
        spawning: "spawning";
        detached: "detached";
        exited: "exited";
        failed: "failed";
        retired: "retired";
    }>;
    stateSource: z.ZodEnum<{
        presence: "presence";
        history: "history";
    }>;
    origin: z.ZodEnum<{
        unknown: "unknown";
        spawned: "spawned";
        adopted: "adopted";
    }>;
    workingOn: z.ZodNullable<z.ZodString>;
    cwd: z.ZodNullable<z.ZodString>;
    gitBranch: z.ZodNullable<z.ZodString>;
    seat: z.ZodNullable<z.ZodString>;
    surface: z.ZodNullable<z.ZodString>;
    profile: z.ZodNullable<z.ZodString>;
    taskId: z.ZodNullable<z.ZodString>;
    spawnedBy: z.ZodNullable<z.ZodString>;
    claudeSessionId: z.ZodNullable<z.ZodString>;
    registeredAt: z.ZodNullable<z.ZodNumber>;
    spawnedAt: z.ZodNullable<z.ZodNumber>;
    lastEventAt: z.ZodNullable<z.ZodNumber>;
    idleMs: z.ZodNullable<z.ZodNumber>;
    dnd: z.ZodBoolean;
    provisional: z.ZodBoolean;
    tags: z.ZodArray<z.ZodString>;
    costUsd: z.ZodNullable<z.ZodNumber>;
    costSource: z.ZodNullable<z.ZodEnum<{
        "session-analytics": "session-analytics";
        "exit-report": "exit-report";
    }>>;
}, z.core.$strip>;
type AgentRosterEntry = z.infer<typeof agentRosterEntry>;
/** How much history the fold saw; the broker caps `/api/history`, so older spawns age out. */
declare const historyWindow: z.ZodObject<{
    events: z.ZodNumber;
    limit: z.ZodNumber;
    oldestAt: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
type HistoryWindow = z.infer<typeof historyWindow>;
declare const agentRosterSnapshot: z.ZodObject<{
    agents: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        idSource: z.ZodEnum<{
            claudeSessionId: "claudeSessionId";
            nameAtRegisteredAt: "nameAtRegisteredAt";
        }>;
        name: z.ZodString;
        agentId: z.ZodNullable<z.ZodString>;
        state: z.ZodEnum<{
            working: "working";
            available: "available";
            blocked: "blocked";
            spawning: "spawning";
            detached: "detached";
            exited: "exited";
            failed: "failed";
            retired: "retired";
        }>;
        stateSource: z.ZodEnum<{
            presence: "presence";
            history: "history";
        }>;
        origin: z.ZodEnum<{
            unknown: "unknown";
            spawned: "spawned";
            adopted: "adopted";
        }>;
        workingOn: z.ZodNullable<z.ZodString>;
        cwd: z.ZodNullable<z.ZodString>;
        gitBranch: z.ZodNullable<z.ZodString>;
        seat: z.ZodNullable<z.ZodString>;
        surface: z.ZodNullable<z.ZodString>;
        profile: z.ZodNullable<z.ZodString>;
        taskId: z.ZodNullable<z.ZodString>;
        spawnedBy: z.ZodNullable<z.ZodString>;
        claudeSessionId: z.ZodNullable<z.ZodString>;
        registeredAt: z.ZodNullable<z.ZodNumber>;
        spawnedAt: z.ZodNullable<z.ZodNumber>;
        lastEventAt: z.ZodNullable<z.ZodNumber>;
        idleMs: z.ZodNullable<z.ZodNumber>;
        dnd: z.ZodBoolean;
        provisional: z.ZodBoolean;
        tags: z.ZodArray<z.ZodString>;
        costUsd: z.ZodNullable<z.ZodNumber>;
        costSource: z.ZodNullable<z.ZodEnum<{
            "session-analytics": "session-analytics";
            "exit-report": "exit-report";
        }>>;
    }, z.core.$strip>>;
    brokerUptimeMs: z.ZodNullable<z.ZodNumber>;
    reconnecting: z.ZodBoolean;
    history: z.ZodObject<{
        events: z.ZodNumber;
        limit: z.ZodNumber;
        oldestAt: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    generatedAt: z.ZodNumber;
}, z.core.$strip>;
type AgentRosterSnapshot = z.infer<typeof agentRosterSnapshot>;
declare const ACTIVITY_CATEGORIES: readonly ["message", "question", "notice", "thinking"];
declare const agentActivityCategory: z.ZodEnum<{
    message: "message";
    question: "question";
    notice: "notice";
    thinking: "thinking";
}>;
type ActivityCategory = z.infer<typeof agentActivityCategory>;
declare const agentGraphNodeActivity: z.ZodObject<{
    category: z.ZodEnum<{
        message: "message";
        question: "question";
        notice: "notice";
        thinking: "thinking";
    }>;
    at: z.ZodNumber;
}, z.core.$strip>;
type NodeActivity = z.infer<typeof agentGraphNodeActivity>;
declare const agentGraphNode: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    rosterId: z.ZodNullable<z.ZodString>;
    parent: z.ZodNullable<z.ZodString>;
    depth: z.ZodNumber;
    row: z.ZodNumber;
    activity: z.ZodNullable<z.ZodObject<{
        category: z.ZodEnum<{
            message: "message";
            question: "question";
            notice: "notice";
            thinking: "thinking";
        }>;
        at: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
type AgentGraphNode = z.infer<typeof agentGraphNode>;
declare const agentGraphEdgeKind: z.ZodEnum<{
    spawned: "spawned";
    message: "message";
}>;
type AgentGraphEdgeKind = z.infer<typeof agentGraphEdgeKind>;
/** `from` and `to` are node ids. `spawned` points spawner to child; `message` points sender to recipient, one per ordered pair. */
declare const agentGraphEdge: z.ZodObject<{
    kind: z.ZodEnum<{
        spawned: "spawned";
        message: "message";
    }>;
    from: z.ZodString;
    to: z.ZodString;
    count: z.ZodNumber;
    lastAt: z.ZodNumber;
}, z.core.$strip>;
type AgentGraphEdge = z.infer<typeof agentGraphEdge>;
declare const agentGraph: z.ZodObject<{
    nodes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        rosterId: z.ZodNullable<z.ZodString>;
        parent: z.ZodNullable<z.ZodString>;
        depth: z.ZodNumber;
        row: z.ZodNumber;
        activity: z.ZodNullable<z.ZodObject<{
            category: z.ZodEnum<{
                message: "message";
                question: "question";
                notice: "notice";
                thinking: "thinking";
            }>;
            at: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    edges: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            spawned: "spawned";
            message: "message";
        }>;
        from: z.ZodString;
        to: z.ZodString;
        count: z.ZodNumber;
        lastAt: z.ZodNumber;
    }, z.core.$strip>>;
    history: z.ZodObject<{
        events: z.ZodNumber;
        limit: z.ZodNumber;
        oldestAt: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    generatedAt: z.ZodNumber;
}, z.core.$strip>;
type AgentGraph = z.infer<typeof agentGraph>;

/**
 * The broker's spawn tree, read off its event log. An `agent_spawned` row puts
 * the spawner in `from` and the spawned name in `meta.target`, which is real
 * parentage rather than a guess about who coordinates. Pure: no clock, no DOM.
 * Ported from agent-chat `src/dashboard/agent-graph.ts`.
 */
declare const HUMAN = "human";
/** A `route_failed` target is what the sender typed (`*`, `?`, `a, b`), so only a resolved name is a peer. */
declare const isPeerName: (name: string) => boolean;
/** `thinking` is the residual: a newest row that is lifecycle rather than talk. */
declare function activityCategory(kind: string): ActivityCategory;
/** Newest activity per name, sender and recipient alike: being asked is as active as asking. */
declare function nodeActivity(items: readonly BrokerEvent[]): Map<string, NodeActivity>;
/** Every name the log knows, each pointing at its spawner (null for a root). */
declare function buildSpawnTree(items: readonly BrokerEvent[]): Map<string, string | null>;

/** Depth is a column, as iTerm panes are placed: the coordinator leftmost, its spawns one column right. */
declare const COLUMN_WIDTH = 186;
declare const ROW_HEIGHT = 30;
declare const PADDING_X = 26;
declare const PADDING_Y = 22;
/** Room to the right of the last column for its labels, which sit beside nodes. */
declare const LABEL_ALLOWANCE = 150;
interface Point {
    x: number;
    y: number;
}
interface GraphNode extends Point {
    name: string;
    depth: number;
    row: number;
    parent: string | null;
}
interface GraphEdge {
    from: string;
    to: string;
}
interface GraphLayout {
    nodes: GraphNode[];
    edges: GraphEdge[];
    byName: Map<string, GraphNode>;
    width: number;
    height: number;
}
declare function layoutSpawnTree(items: readonly BrokerEvent[]): GraphLayout;

/** The fields of a grouped chat feed entry that spark routing reads. */
interface SparkSource {
    msgId: string;
    kind: string;
    from: string;
    at: number;
    recipients: readonly string[];
}
/**
 * The names a message travels through along tree edges, up to the lowest common
 * ancestor and back down, so no edge the spawn tree lacks is drawn. Names in
 * different trees return the pair as-is: one straight jump, honestly a jump.
 */
declare function treePath(layout: GraphLayout, from: string, to: string): string[];
interface SparkRoute {
    from: string;
    to: string;
    category: ActivityCategory;
    points: Point[];
}
/** One route per recipient of a send. Recipients off the graph are dropped. */
declare function sparkRoutes(layout: GraphLayout, entry: SparkSource): SparkRoute[];
/** Position at fraction `t` of a polyline, measured by length so a spark keeps constant speed. */
declare function pointAlongPolyline(points: readonly Point[], t: number): Point;
/** How long a spark takes to travel its route, whatever the route's length. */
declare const SPARK_DURATION_MS = 1100;
/** How long after an event a node keeps its glow. */
declare const GLOW_DURATION_MS = 6000;
interface Spark extends SparkRoute {
    id: string;
    startedAt: number;
}
/** Sparks for entries newer than `since`, so a refetch cannot replay the feed. */
declare function sparksSince(layout: GraphLayout, entries: readonly SparkSource[], since: number, now: number): Spark[];
declare function liveSparks(sparks: readonly Spark[], now: number): Spark[];
/** 1 at the instant of the event, 0 once the glow has decayed. */
declare function glowStrength(activity: NodeActivity | undefined, now: number): number;

/** What the event log says about one agent name: its newest spawn row and the lifecycle rows after it. */
interface AgentRecord {
    name: string;
    agentId: string;
    spawnedBy: string;
    spawnedAt: number;
    adopted: boolean;
    meta: Record<string, string>;
    brief: string;
    lifecycle: "spawning" | "live" | "detached" | "exited" | "failed" | "retired";
    lastEventAt: number;
    exitCostUsd: number | null;
}
/** One record per name that has a spawn row in the window; a respawn replaces the older record. */
declare function foldAgentRecords(events: readonly BrokerEvent[]): Map<string, AgentRecord>;

/** Below this uptime the broker's in-memory registry is still refilling after a restart. */
declare const RECONNECT_WINDOW_MS = 10000;
interface SeatPrefix {
    seat: string;
    prefix: string;
}
interface RosterInput {
    sessions: readonly BrokerSession[];
    brokerUptimeMs: number | null;
    events: readonly BrokerEvent[];
    historyLimit: number;
    now: number;
    /** Seats own the agents named `<prefix>-...`; the longest matching prefix wins. */
    seatPrefixes?: readonly SeatPrefix[];
    /** A priced transcript total for a Claude Code session id, from session-analytics. */
    costOf?: (claudeSessionId: string) => number | undefined;
}
/** Live sessions first, then agents known only from history, each with where its state came from. */
declare function foldRoster(input: RosterInput): AgentRosterSnapshot;
declare function historyWindowOf(events: readonly BrokerEvent[], limit: number): HistoryWindow;
declare function seatOf(name: string, prefixes: readonly SeatPrefix[]): string | null;

interface AgentGraphInput {
    events: readonly BrokerEvent[];
    historyLimit: number;
    now: number;
    /** Joins graph nodes to roster rows by name. */
    roster?: readonly AgentRosterEntry[];
}
/** The spawn tree as nodes, plus spawned-by and message edges with counts. */
declare function foldAgentGraph(input: AgentGraphInput): AgentGraph;

export { ACTIVITY_CATEGORIES, type ActivityCategory, type AgentCostSource, type AgentGraph, type AgentGraphEdge, type AgentGraphEdgeKind, type AgentGraphInput, type AgentGraphNode, type AgentIdSource, type AgentOrigin, type AgentRecord, type AgentRosterEntry, type AgentRosterSnapshot, type AgentState, type AgentStateSource, type BrokerEvent, type BrokerSession, COLUMN_WIDTH, GLOW_DURATION_MS, type GraphEdge, type GraphLayout, type GraphNode, HISTORY_STATES, HUMAN, type HistoryWindow, LABEL_ALLOWANCE, LIVE_HISTORY_STATES, type NodeActivity, PADDING_X, PADDING_Y, PRESENCE_STATES, type Point, RECONNECT_WINDOW_MS, ROW_HEIGHT, type RosterInput, SPARK_DURATION_MS, type SeatPrefix, type Spark, type SparkRoute, type SparkSource, activityCategory, agentActivityCategory, agentCostSource, agentGraph, agentGraphEdge, agentGraphEdgeKind, agentGraphNode, agentGraphNodeActivity, agentIdSource, agentOrigin, agentRosterEntry, agentRosterSnapshot, agentState, agentStateSource, brokerEvent, brokerHistory, brokerSession, brokerSessions, buildSpawnTree, foldAgentGraph, foldAgentRecords, foldRoster, glowStrength, historyWindow, historyWindowOf, isPeerName, layoutSpawnTree, liveSparks, nodeActivity, pointAlongPolyline, seatOf, sparkRoutes, sparksSince, treePath };

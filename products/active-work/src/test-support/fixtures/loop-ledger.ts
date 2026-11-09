/** Synthetic open-loops sweep and tech tree in the sweep's own layout (TP-4316). */

export const SNAPSHOT = `# Open loops sweep (synthetic). Schema: see the sweep notes.
loops:
  - id: loop-a
    title: "Synthetic loop A"
    initiative: sample-initiative
    owning_seat: "seat-k"
    done_when: "A is shipped"
    status: ACTIVE
    first_raised: 2026-07-01
    last_motion: {date: 2026-07-10, ref: "SI-1 touched"}
    owner_emphasis: {messages: 4, distinct_days: 2, last_raised: 2026-07-09, score: 20}
    linked_tasks: {ids: ["SI-1"], open: 1, done: 0}
    linked_prs_open: ["acme/widgets#7"]
    blockers: {owner_gated: ["deposit: approve A"], other: []}
    tech_tree_node: N1
  - id: loop-b
    title: "Synthetic loop B"
    initiative: other-initiative
    owning_seat: "none"
    done_when: "B is decided"
    status: STALLED
    first_raised: 2026-07-02
    last_motion: {date: 2026-07-05, ref: "owner ask only"}
    owner_emphasis: {messages: 1, distinct_days: 1, last_raised: 2026-07-05, score: 6}
    linked_tasks: {ids: [], open: 0, done: 0}
    linked_prs_open: []
    blockers: {owner_gated: [], other: ["waits on loop-a"]}
    tech_tree_node: N2
  - id: loop-c
    title: "Synthetic loop C"
    initiative: sample-initiative
    owning_seat: "seat-k"
    done_when: "C is gone"
    status: DONE
    first_raised: 2026-07-03
    last_motion: {date: 2026-07-04, ref: "closed"}
    tech_tree_node: N2
`;

export const TREE = `# Tech tree (synthetic).
goals:
  G1: "Synthetic goal one"
  G2: "Synthetic goal two"
nodes:
  - id: N1
    title: "Node one"
    goal: G1
    depends_on: []
    loops: ["loop-a"]
    state: "in progress"
    done_when: "N1 works"
    churn: {closed_14d: 3, open_now: 2, done_when_moved: partly, high_churn_no_progress: false}
  - id: N2
    title: "Node two"
    goal: G2
    depends_on: ["N1"]
    loops: ["loop-b"]
    state: "not started"
    done_when: "N2 works"
    churn: {closed_14d: 9, open_now: 4, done_when_moved: no, high_churn_no_progress: true}
`;

export const TIER_SEED = { S: ['loop-b'], A: ['loop-a'], Parked: ['loop-c'] };

/*
 * Which parts of the system a lane's work lands through (operating model PROPOSAL 2.3, TP-5652), so a deploy stall or a
 * red main holds only the lanes that depend on the failing part. Data, checked in beside the code it describes: an entry
 * changes when a product's deploy path changes, and that change is reviewed in the same pull request.
 */

/**
 * `factory-deploy` is the factory build's own deploy, the one target the deploy pacer lands and serve's `/health` deploy
 * block reports. `main:<owner>/<repo>` is that repo's main CI, red while Shepherd holds the repo frozen.
 */
export type Component = "factory-deploy" | `main:${string}/${string}`;

interface LaneDependency {
  initiative: string;
  /** The lane's tag; null is the lane of the whole initiative. */
  tag: string | null;
  components: readonly Component[];
  /** Why the lane lands through exactly these components. */
  why: string;
}

/** A lane without an entry depends on everything, so any stall holds it. */
const LANE_COMPONENTS: readonly LaneDependency[] = [
  {
    initiative: "titan-platform",
    tag: "console",
    components: ["main:hjewkes/titan-platform", "factory-deploy"],
    why: "apps/console merges to titan-platform main, and its owner actions are titan-factory routes that land only with a factory deploy",
  },
  {
    initiative: "titan-platform",
    tag: "factory",
    components: ["main:hjewkes/titan-platform", "factory-deploy"],
    why: "products/factory merges to titan-platform main and lands only when the pacer deploys the new factory build",
  },
  {
    initiative: "titan-platform",
    tag: "shepherd",
    components: ["main:hjewkes/titan-platform", "factory-deploy"],
    why: "Shepherd runs inside the factory build, so its work lands through titan-platform main and the factory deploy",
  },
];

/** The components a lane depends on; undefined when the lane has no entry, which means every component. */
export function laneComponents(lane: { initiative: string; tag?: string }, table: readonly LaneDependency[] = LANE_COMPONENTS): readonly Component[] | undefined {
  return table.find((entry) => entry.initiative === lane.initiative && entry.tag === (lane.tag ?? null))?.components;
}

import type { PanelMember, PanelPlan, PrClass, PrTouch, ReviewClass, ReviewShape } from "./types.js";

/** One agent-chat profile per class; the profile carries the member's model and effort. */
export type ClassRoles = Record<ReviewClass, string>;

type ExtraShape = Exclude<ReviewShape, "correctness">;

/** A shape the panel adds beside correctness: on a class in `classes` with any of `touches`. */
export interface ShapeRule {
  shape: ExtraShape;
  classes: readonly ReviewClass[];
  touches: readonly PrTouch[];
  blocking: boolean;
}

/** Whether opus may be spawned now; the caller asks its spawn gate. */
export interface Headroom {
  opus: boolean;
}

export interface PanelPolicy {
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
  points?: { opus: number; sonnet: number };
}

export const DEFAULT_CLASS_ROLES: ClassRoles = { g10: "bd-reviewer", standard: "reviewer" };

/** Sonnet everywhere: the one opus seat per head is the g10 correctness member's. */
export const DEFAULT_SHAPE_ROLES: Record<ExtraShape, ClassRoles> = {
  adversary: { g10: "reviewer", standard: "reviewer" },
  tests: { g10: "reviewer", standard: "reviewer" },
  visual: { g10: "reviewer", standard: "reviewer" },
  perf: { g10: "reviewer", standard: "reviewer" },
};

/** The plan's class table. `tests` stays advisory here; a bad fix-proof result makes it block at aggregation. */
export const DEFAULT_PANEL_TABLE: readonly ShapeRule[] = [
  { shape: "adversary", classes: ["g10"], touches: ["authority", "policy", "security", "migration"], blocking: true },
  { shape: "tests", classes: ["g10", "standard"], touches: ["untested"], blocking: false },
  { shape: "visual", classes: ["standard"], touches: ["visual"], blocking: false },
  { shape: "perf", classes: ["g10"], touches: ["large", "perf"], blocking: false },
];

export const DEFAULT_SONNET_FOR: Record<string, string> = { "bd-reviewer": "reviewer" };

/** Placeholder weights until the scorecard reports measured spend per member. */
export const DEFAULT_MEMBER_POINTS = { opus: 3, sonnet: 1 };

/** No panel table: correctness alone, exactly as TP-1428 routes the single reviewer today. */
export const DEFAULT_PANEL_POLICY: PanelPolicy = { roles: DEFAULT_CLASS_ROLES };

const MAX_MEMBERS = 3;
const MAX_OPUS = 1;

function sonnetProfileOf(profile: string, policy: PanelPolicy): string | undefined {
  const sonnetFor = policy.sonnetFor ?? DEFAULT_SONNET_FOR;
  return Object.hasOwn(sonnetFor, profile) ? sonnetFor[profile] : undefined;
}

interface Seat {
  shape: ReviewShape;
  profile: string;
  blocking: boolean;
}

function seats(cls: PrClass, policy: PanelPolicy): Seat[] {
  const correctness: Seat = { shape: "correctness", profile: policy.roles[cls.class], blocking: true };
  const extras = (policy.panel ?? [])
    .filter((rule) => rule.classes.includes(cls.class) && rule.touches.some((t) => cls.touches.includes(t)))
    .map((rule) => ({ shape: rule.shape, blocking: rule.blocking, profile: (policy.shapeRoles?.[rule.shape] ?? DEFAULT_SHAPE_ROLES[rule.shape])[cls.class] }));
  return [correctness, ...extras].slice(0, MAX_MEMBERS);
}

/** Opus beyond the per-head cap is lowered quietly; opus refused by headroom is lowered and marked degraded. */
function seatMembers(list: readonly Seat[], policy: PanelPolicy, headroom: Headroom): PanelMember[] {
  let opusSeats = 0;
  return list.map(({ shape, profile, blocking }) => {
    const briefId = policy.briefIds?.[shape] ?? shape;
    const sonnet = sonnetProfileOf(profile, policy);
    if (sonnet === undefined) return { shape, profile, briefId, blocking, degraded: false };
    if (!headroom.opus) return { shape, profile: sonnet, briefId, blocking, degraded: true };
    if (opusSeats >= MAX_OPUS) return { shape, profile: sonnet, briefId, blocking, degraded: false };
    opusSeats += 1;
    return { shape, profile, briefId, blocking, degraded: false };
  });
}

function spendEstimate(members: readonly PanelMember[], policy: PanelPolicy): number {
  const points = policy.points ?? DEFAULT_MEMBER_POINTS;
  return members.reduce((sum, m) => sum + (sonnetProfileOf(m.profile, policy) === undefined ? points.sonnet : points.opus), 0);
}

/** The panel for one head: at most 3 members and 1 opus member. Spend is estimated, never capped. Pure. */
export function planPanel(cls: PrClass, policy: PanelPolicy, headroom: Headroom): PanelPlan {
  const members = seatMembers(seats(cls, policy), policy, headroom);
  return { class: cls, members, spendEstimate: spendEstimate(members, policy), degraded: members.some((m) => m.degraded) };
}

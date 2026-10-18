import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";

// A TP-side mirror of titan-design's visual router (react-ui `visual-router` subpath, TP-3597). The
// pinned copy is doctrine/visual-router.json, written by scripts/pin-visual-router.mjs. The schema is
// strict, so a renamed or added upstream field fails the parse instead of drifting silently.
const Id = z.string().min(1);
const NotThisSchema = z.object({ when: z.string().min(1), use: Id }).strict();
const RenderSchema = z.object({ component: Id, preset: Id.optional() }).strict();
const ClosestSchema = z.object({ type: Id, component: Id, caveat: z.string().min(1).nullable() }).strict();
export const VISUAL_STATUSES = ["have", "in-flight", "ng", "new", "template", "skip"] as const;

const PatternSchema = z
  .object({ id: Id, name: Id, trigger: z.string().min(1), primitives: z.array(z.string().min(1)), budget: z.string().min(1), nearestType: Id })
  .strict();

const TypeSchema = z
  .object({
    id: Id,
    name: Id,
    bestFor: z.string().min(1),
    notThis: z.array(NotThisSchema),
    patterns: z.array(Id),
    budget: z.string().min(1),
    status: z.enum(VISUAL_STATUSES),
    component: Id.nullable(),
    storyId: Id.nullable(),
    preset: Id.optional(),
    basis: z.string(),
    fallback: z.array(Id),
    route: z.object({ render: RenderSchema.nullable(), closest: ClosestSchema, gap: z.boolean() }).strict(),
  })
  .strict();

export const VisualRouterSchema = z
  .object({
    source: z.object({ package: Id, subpath: Id, commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
    patterns: z.array(PatternSchema).min(1),
    types: z.array(TypeSchema).min(1),
  })
  .strict();

export type VisualRouter = z.infer<typeof VisualRouterSchema>;
export type VisualType = VisualRouter["types"][number];

/** The router card a beat builder sees for its beat's visual kind. */
export interface VisualCard {
  type: string;
  name: string;
  status: VisualType["status"];
  gap: boolean;
  /** For a gap: what is not built and what to draw instead. */
  warning: string | null;
  render: VisualType["route"]["render"];
  closest: VisualType["route"]["closest"];
  best_for: string;
  budget: string;
  not_this: VisualType["notThis"];
}

export function loadVisualRouter(dir: string = DEFAULT_DOCTRINE_DIR): VisualRouter {
  return VisualRouterSchema.parse(JSON.parse(readFileSync(join(dir, "visual-router.json"), "utf8")));
}

let shipped: VisualRouter | undefined;

/** The pinned router shipped in this package's doctrine dir, read once. */
export const shippedVisualRouter = (): VisualRouter => (shipped ??= loadVisualRouter());

export const findVisualType = (router: VisualRouter, id: string): VisualType | undefined => router.types.find((type) => type.id === id);

export function visualCard(type: VisualType): VisualCard {
  const { route } = type;
  return {
    type: type.id,
    name: type.name,
    status: type.status,
    gap: route.gap,
    warning: route.gap ? route.closest.caveat : null,
    render: route.render,
    closest: route.closest,
    best_for: type.bestFor,
    budget: type.budget,
    not_this: type.notThis,
  };
}

const cell = (text: string): string => text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");

const rendersNow = ({ route }: VisualType): string =>
  route.render ? [route.render.component, route.render.preset].filter(Boolean).join(" ") : `gap: draw \`${route.closest.type}\` (${route.closest.component})`;

function patternCard(router: VisualRouter, pattern: VisualRouter["patterns"][number]): string[] {
  const nearest = findVisualType(router, pattern.nearestType);
  const now = nearest ? rendersNow(nearest) : "unknown type";
  return [
    `### ${pattern.name} (\`${pattern.id}\`)`,
    "",
    pattern.trigger,
    "",
    `- Show: ${pattern.primitives.join("; ")}.`,
    `- Budget: ${pattern.budget}`,
    `- Draw with: \`${pattern.nearestType}\` (${now})`,
    "",
  ];
}

function typeRow(type: VisualType): string {
  const notThis = type.notThis.map(({ when, use }) => `${when}: \`${use}\``).join("; ");
  return `| \`${type.id}\` | ${type.status} | ${cell(rendersNow(type))} | ${cell(type.bestFor)} | ${cell(notThis) || "-"} |`;
}

/**
 * The plan stage's routing table: pattern cards, then one row per type. A planner names a type in
 * a beat's `kind`; a gap type is allowed, and its row says what renders in its place.
 */
export function renderRoutingTable(router: VisualRouter): string {
  return [
    "## Visual router",
    "",
    "Pick a pattern first when behaviour, risk or enforcement is the point of the picture, and draw it with the pattern's type. Otherwise pick the type by what it is best for and check its not-this list. Put the type id in the beat's `kind`.",
    "",
    ...router.patterns.flatMap((pattern) => patternCard(router, pattern)),
    "| Type | Status | Renders now | Best for | Not this |",
    "| --- | --- | --- | --- | --- |",
    ...router.types.map(typeRow),
    "",
  ].join("\n");
}

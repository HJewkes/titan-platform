// The owner design round for TP-4317: one CHOICE per page plus the type scale, frames for every direction.

export const UNIT = "tp4317-density-explore";
const BY = "csc-tp4317-density-explore";
const SOURCE = "Free HTML on branch feat/tp4317-density-explore under apps/console/explore/tp4317-density (node build.mjs, then node round.mjs <dir>).";

export const CONTEXT = `Density pass for #/loops and #/tree after the 2026-10-27 note that both pages feel very dense ("old Salesforce"). Only spacing, type and hierarchy change: every field, the tier order with Unsorted first, the advisory wording, drag plus the Move to menu, the filters, the Dependencies / Goal lanes toggle and the selected-node panel are as on the open PRs. Synthetic data, dark theme, titan-design tokens. ${SOURCE}`;

const LOOP_DIRECTIONS = {
  airy: "Loops A · Airy, two-column cards",
  cards: "Loops B · Tier panels, grouped cards",
  table: "Loops C · Compact table per tier",
};
const TREE_DIRECTIONS = {
  airy: "Tree A · Airy nodes, panel beside",
  cards: "Tree B · Goal strip, card nodes",
  table: "Tree C · Compact nodes, panel table",
};
const SCALE_LABELS = {
  current: "Current (14 / 16 / 20)",
  roomy: "Roomy, ratio 1.25 (15 / 19 / 24 / 30)",
  compact: "Compact, ratio 1.2 (14 / 16 / 20 / 24)",
};

const PAGES = [
  { unit: "loops", name: "Open loops", options: LOOP_DIRECTIONS },
  { unit: "tree", name: "Tech tree", options: TREE_DIRECTIONS },
  { unit: "type", name: "Type scale", options: SCALE_LABELS },
];

/** Every page and option at both widths; each `page` names its built html file. */
export function variants() {
  return PAGES.flatMap(({ unit, name, options }) =>
    Object.entries(options).flatMap(([key, label]) =>
      [1440, 390].map((width) => ({
        key: `${unit}-${key}-${width}`,
        image: `frames/${unit}-${key}-${width}.png`,
        label: `${name}, ${label}, ${width} px`,
        variantUnit: `${unit}-${key}`,
        page: `${unit}-${key}`,
        width,
      })),
    ),
  );
}

const keysOf = (unit) => variants().filter((variant) => variant.key.startsWith(`${unit}-`)).map((variant) => variant.key);

function optionsOf(unit, labels) {
  const options = Object.values(labels);
  const optionVariants = Object.fromEntries(Object.entries(labels).map(([key, label]) => [label, `${unit}-${key}-1440`]));
  return { options, optionVariants };
}

export const SECTIONS = [
  {
    id: "loops",
    title: "#/loops density",
    deciding: "Which density direction the open-loops tier list moves to.",
    changed: "A: unboxed tiers, two-column cards, 56 px between tiers, roomy type. B: each tier a raised panel with a coloured rail, a big tier letter and count; three-column cards with refs and Move to in a footer. C: each tier a table, one 56 px row per loop with fixed columns; on a phone a two-line row.",
    context: "Same 18 synthetic loops in each. Tier hues in B are tokens (brand, status, secondary), not new colours.",
    kind: "CHOICE",
    variantKeys: keysOf("loops"),
    parts: [{ id: "loops-density", label: "#/loops density", proposed: "loopsDensity: \"airy\" | \"grouped-cards\" | \"compact-table\"", lang: "ts" }],
    questionIds: ["loops-density"],
  },
  {
    id: "tree",
    title: "#/tree density",
    deciding: "Which density direction the tech-tree page moves to.",
    changed: "A: 220 x 76 nodes with a state dot and a second meta line, the node panel beside the graph at desktop. B: a goal progress strip above the graph (done of total per goal, from node states), nodes as cards with a state rail and goal label. C: 168 x 34 single-line nodes, the panel as a label / value table.",
    context: "All three draw the Dependencies tab; Goal lanes would take the same node style. Node N03 (Offline tiles) is selected in each.",
    kind: "CHOICE",
    variantKeys: keysOf("tree"),
    parts: [{ id: "tree-density", label: "#/tree density", proposed: "treeDensity: \"airy\" | \"grouped-cards\" | \"compact\"", lang: "ts" }],
    questionIds: ["tree-density"],
  },
  {
    id: "type",
    title: "Type scale",
    deciding: "Which type scale both pages, and later the design system's page tokens, use.",
    changed: "Current is the console today (14 body, 16 card title, 20 heading). Roomy steps by 1.25 with 1.55 line height. Compact steps by 1.2 but adds weight contrast (600 titles) instead of size.",
    context: "Inter and Space Grotesk are not installed on the shooting host, so frames use the system fallback, as the console does here.",
    kind: "CHOICE",
    variantKeys: keysOf("type"),
    parts: [{ id: "type-scale", label: "Type scale", proposed: "typeScale: \"current\" | \"roomy-1.25\" | \"compact-1.2\"", lang: "ts" }],
    questionIds: ["type-scale"],
  },
];

export const QUESTIONS = [
  {
    id: "loops-density",
    signsOff: "loops-density",
    kind: "pick-one",
    required: true,
    prompt: "Which direction should #/loops take to read less dense and more scannable?",
    ...optionsOf("loops", LOOP_DIRECTIONS),
    frames: keysOf("loops"),
    recommendation: {
      answer: LOOP_DIRECTIONS.cards,
      confidence: 0.6,
      by: BY,
      rationale: "The tier is the unit you scan by, and B makes each tier one labelled panel you can find at a glance while cards keep breathing room.",
      weakPoint: "Three columns at desktop still put many cards on screen; with 60+ loops it scrolls further than C.",
    },
  },
  {
    id: "tree-density",
    signsOff: "tree-density",
    kind: "pick-one",
    required: true,
    prompt: "Which direction should #/tree take?",
    ...optionsOf("tree", TREE_DIRECTIONS),
    frames: keysOf("tree"),
    recommendation: {
      answer: TREE_DIRECTIONS.airy,
      confidence: 0.55,
      by: BY,
      rationale: "Bigger two-line nodes and the panel beside the graph read cleanly without scrolling away from the selection.",
      weakPoint: "At phone width the larger nodes mean more sideways scrolling than C.",
    },
  },
  {
    id: "type-scale",
    signsOff: "type-scale",
    kind: "pick-one",
    required: true,
    prompt: "Which type scale should these pages use?",
    ...optionsOf("type", SCALE_LABELS),
    frames: keysOf("type"),
    recommendation: {
      answer: SCALE_LABELS.roomy,
      confidence: 0.65,
      by: BY,
      rationale: "Clear size steps between page, tier and card title give the hierarchy the current flat 14 / 16 scale lacks.",
      weakPoint: "15 px body is a step up from react-ui's default body size, so it becomes a design-system token change, not a page tweak.",
    },
  },
];

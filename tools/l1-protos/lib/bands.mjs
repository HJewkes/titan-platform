// D1 tier bands: the CI tiers as full-width rows (dependents on top), the top-k packages of
// each tier by interest plus a "+N more" tile, and band-to-band summary edges in a right
// gutter, one lane per tier pair, short spans innermost so lanes do not cross.
import { aggregate, shortName } from "./model.mjs";
import { PAD, boxSize, edgeElement, element, strokeFor } from "./scene.mjs";
import { placePills } from "./labels.mjs";

export const TIER_ORDER = ["product", "ui", "2", "1", "0"];
const ROW = { pad: 18, gap: 44, chipGap: 16 };
const LANE = 66;

function rowsOf(model, k) {
  return TIER_ORDER.map((tier) => {
    const members = [...model.packages.values()].filter((p) => p.tier === tier).sort((a, b) => b.interest - a.interest);
    // A "+1 more" tile costs the same box as the package it hides, so show the package.
    const shown = members.length === k + 1 ? k + 1 : k;
    const chips = members.slice(0, shown).map((p) => ({ id: `pkg:${p.id}`, kind: "box", lines: [shortName(p.id)] }));
    if (members.length > shown) chips.push({ id: `more:tier:${tier}`, kind: "tile", lines: [`+${members.length - shown} more`] });
    return { id: `tier:${tier}`, lines: [`tier ${tier} · ${members.length} pkg${members.length === 1 ? "" : "s"}`], chips };
  });
}

function placeRows(rows) {
  const header = Math.max(...rows.map((r) => boxSize(r.lines).w)) + PAD;
  const chipH = boxSize(["x"]).h;
  const elements = [];
  let right = 0;
  rows.forEach((r, i) => {
    const y = i * (chipH + 2 * ROW.pad + ROW.gap);
    let x = header + PAD;
    for (const c of r.chips) {
      const { w, h } = boxSize(c.lines);
      elements.push(element(c.id, c.kind, c.lines, { x, y: y + ROW.pad, w, h }));
      x += w + ROW.chipGap;
    }
    right = Math.max(right, x + PAD);
    r.box = { x: 0, y, w: 0, h: chipH + 2 * ROW.pad };
  });
  for (const r of rows) elements.unshift(element(r.id, "container", r.lines, { ...r.box, w: right }));
  return { elements, right, height: rows.at(-1).box.y + rows.at(-1).box.h };
}

// Spread each row's edge ends down its right side so no two edges share an end point.
function endY(rows, edges) {
  const slots = new Map();
  for (const e of edges) for (const end of [e.src, e.dst]) slots.set(end, (slots.get(end) ?? 0) + 1);
  const used = new Map();
  return (end) => {
    const r = rows.find((x) => x.id === end).box;
    const n = used.get(end) ?? 0;
    used.set(end, n + 1);
    return r.y + (r.h * (n + 1)) / (slots.get(end) + 1);
  };
}

export async function tierBands(model, k = 3) {
  const rows = rowsOf(model, k);
  const { elements, right, height } = placeRows(rows);
  const order = (id) => TIER_ORDER.indexOf(id.slice(5));
  const edges = aggregate(model.pkgEdges, (id) => `tier:${model.packages.get(id).tier}`)
    .sort((a, b) => Math.abs(order(a.src) - order(a.dst)) - Math.abs(order(b.src) - order(b.dst)) || (a.id < b.id ? -1 : 1));
  const yOf = endY(rows, edges);
  const labelled = edges.map((e, lane) => {
    const x = right + LANE * (lane + 0.5);
    const [y0, y1] = [yOf(e.src), yOf(e.dst)];
    const points = [{ x: right, y: y0 }, { x, y: y0 }, { x, y: y1 }, { x: right, y: y1 }];
    return [edgeElement(e.id, points, { sw: strokeFor(e.pairs) }), String(e.pairs)];
  });
  const all = [...elements, ...labelled.map(([e]) => e)];
  const { pills, dropped } = placePills(all, labelled);
  const subtitle = `top ${k} packages per tier by fan-in · right gutter: package edges between tiers`;
  return { elements: [...all, ...pills], width: right + LANE * edges.length + PAD, height, pillsDropped: dropped, name: "d1-tier-bands", title: "D1 · tier bands (declared CI tiers)", subtitle };
}

// SVG painters for the debug map (TP-2816). Each SVG is drawn for one FRAME_WIDTH-px screen:
// strokes use `vector-effect: non-scaling-stroke`, so a 100k-unit canvas fit to that width
// still shows its lines, and text is sized in screen px, not layout units.
import { labelOverlaps, rectsIntersect } from "./repo-map-metrics.mjs";

export const FRAME_WIDTH = 3000;
// Labels are monospace, so a renderer and the layout agree on their width: 0.6 em a character.
export const CHAR_WIDTH = 0.6;
const SCREEN_FONT = 14;

const STYLE = `<style>
rect,path{vector-effect:non-scaling-stroke}
.pkg{fill:#eef3fb;stroke:#4a6fa5;stroke-width:1.5}.dir{fill:#fbfbf4;stroke:#a59a4a;stroke-width:.5}
.file{fill:#fff;stroke:#bbb;stroke-width:.3}.l1{fill:none;stroke:#c0392b;stroke-width:1.5}
.l2dir{fill:none;stroke:#8e44ad;stroke-width:.8;stroke-dasharray:4 3}.l2file{fill:none;stroke:#555;stroke-width:.3;opacity:.5}
text{font-family:"DejaVu Sans Mono",Menlo,monospace;fill:#1b2a41}
</style>`;

function escape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function rect(box, cls) {
  const [x, y] = [box.x - box.width / 2, box.y - box.height / 2];
  return `<rect class="${cls}" x="${x}" y="${y}" width="${box.width}" height="${box.height}"/>`;
}

// `r` is the label's top-left rectangle; the baseline sits at 80% of the font size.
function text(r, body, fontSize) {
  return `<text x="${r.x}" y="${r.y + fontSize * 0.8}" font-size="${fontSize}">${escape(body)}</text>`;
}

function paths(edges, cls, layout) {
  return edges
    .map((e) => layout.routeOf(e))
    .filter(Boolean)
    .map((route) => `<path class="${cls}" d="${layout.routeToPathD(route)}"/>`);
}

function svg(canvas, body) {
  const { width, height } = { width: canvas.width + 20, height: canvas.height + 20 };
  const screenHeight = Math.round((FRAME_WIDTH * height) / width);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${screenHeight}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#fff"/>${STYLE}
${body.join("\n")}
</svg>
`;
}

export function labelRect(box, body, fontSize, padding) {
  const [x, y] = [box.x - box.width / 2 + padding, box.y - box.height / 2 + padding];
  return { x, y, width: body.length * CHAR_WIDTH * fontSize, height: fontSize };
}

/** L1: label-sized package boxes, their labels inside, and the package edges. */
export function renderL1(l1, canvas, labelMetrics, layout) {
  const { fontSize, padding } = labelMetrics;
  const rects = l1.nodes.map((n) => labelRect(n, n.name, fontSize, padding));
  const body = [
    ...l1.nodes.map((n) => rect(n, "pkg")),
    ...paths(l1.edges, "l1", layout),
    ...l1.nodes.map((n, i) => text(rects[i], n.name, fontSize)),
  ];
  return { svg: svg(canvas, body), labels: { shown: rects.length, hidden: 0, overlaps: labelOverlaps(rects) } };
}

// At L2 a package box can be far narrower than a label readable at frame size, so labels are
// placed largest box first and a label that would overlap one already placed is left out.
function placeLabels(pkgs, fontSize, nameOf) {
  const placed = [];
  const bySize = [...pkgs].sort((a, b) => b.width * b.height - a.width * a.height || (a.id < b.id ? -1 : 1));
  for (const g of bySize) {
    const r = { ...labelRect(g, nameOf(g), fontSize, fontSize / 4), body: nameOf(g) };
    if (!placed.some((p) => rectsIntersect(p, r))) placed.push(r);
  }
  return placed;
}

/** L2: every box, file edges, dashed directory edges, and the package labels that fit. */
export function renderL2(result, canvas, ids, layout) {
  const fontSize = (SCREEN_FONT * (canvas.width + 20)) / FRAME_WIDTH;
  const pkgs = result.groups.filter((g) => g.id.startsWith(ids.PKG));
  const dirs = result.groups.filter((g) => g.id.startsWith(ids.DIR));
  const fileEdges = result.edges.filter((e) => !e.srcId.startsWith(ids.PKG) && !e.srcId.startsWith(ids.DIR));
  const placed = placeLabels(pkgs, fontSize, (g) => g.id.slice(ids.PKG.length));
  const body = [
    ...pkgs.map((g) => rect(g, "pkg")),
    ...dirs.map((g) => rect(g, "dir")),
    ...result.nodes.map((n) => rect(n, "file")),
    ...paths(fileEdges, "l2file", layout),
    ...paths(result.edges.filter((e) => e.srcId.startsWith(ids.DIR)), "l2dir", layout),
    ...placed.map((r) => text(r, r.body, fontSize)),
  ];
  const labels = { shown: placed.length, hidden: pkgs.length - placed.length, overlaps: labelOverlaps(placed) };
  return { svg: svg(canvas, body), labels };
}

// Readability numbers for the debug map (TP-2816): how far edges bend, whether one cuts a
// box that is not its end, and whether two labels overlap. Pure functions over laid-out boxes
// (centre x/y, like LaidOutNode) and absolute routes.

/** The extent of every box and route point; ELK may route an edge outside every box. */
export function canvasOf(boxes, routes = []) {
  const points = routes.flat();
  const width = Math.max(...boxes.map((b) => b.x + b.width / 2), ...points.map((p) => p.x));
  const height = Math.max(...boxes.map((b) => b.y + b.height / 2), ...points.map((p) => p.y));
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

// An orthogonal segment cuts a box when it enters the box's interior; touching the border does not.
function segmentCuts(a, b, box) {
  const [left, right] = [box.x - box.width / 2, box.x + box.width / 2];
  const [top, bottom] = [box.y - box.height / 2, box.y + box.height / 2];
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x1 > left + 0.5 && x0 < right - 0.5 && y1 > top + 0.5 && y0 < bottom - 0.5;
}

function cutsForeignBox(edge, route, boxes) {
  const foreign = boxes.filter((b) => b.id !== edge.srcId && b.id !== edge.dstId);
  return route.slice(1).some((p, i) => foreign.some((box) => segmentCuts(route[i], p, box)));
}

/** Bends, foreign-box cuts and upward edges for the edges between `boxes` (direction DOWN). */
export function routeMetrics(edges, boxes, routeOf) {
  const routed = edges.map((e) => ({ edge: e, route: routeOf(e) })).filter((r) => r.route);
  const bends = routed.map((r) => r.route.length - 2);
  const mean = bends.length ? bends.reduce((s, b) => s + b, 0) / bends.length : 0;
  return {
    edges: edges.length,
    routed: routed.length,
    meanBends: Math.round(mean * 100) / 100,
    maxBends: Math.max(0, ...bends),
    foreignCuts: routed.filter((r) => cutsForeignBox(r.edge, r.route, boxes)).length,
    upward: routed.filter((r) => r.route.at(-1).y < r.route[0].y).length,
  };
}

export function rectsIntersect(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Pairs of label rectangles (top-left x/y) that overlap. */
export function labelOverlaps(rects) {
  let count = 0;
  for (const [i, a] of rects.entries()) for (const b of rects.slice(i + 1)) if (rectsIntersect(a, b)) count++;
  return count;
}

// Scenes (layout units) to frames (screen px), and the level-transition clip's timeline.
import { cameraOnto, fitTransform, toScreen } from "./scene.mjs";
import { labelEdgeHits } from "./labels.mjs";

/** A design's static frame: the scene fitted into the 1920x1080 content area. */
export function frameOf(scene) {
  const t = fitTransform(scene.width, scene.height);
  const elements = toScreen(scene.elements, t);
  const checks = { pillsDropped: scene.pillsDropped ?? 0, labelEdgeHits: labelEdgeHits(elements) };
  return { name: scene.name, title: scene.title, subtitle: scene.subtitle, fit: +t.s.toFixed(3), k: scene.k ?? null, checks, elements };
}

export function staticData(frame) {
  return { static: true, frames: [frame], timeline: [{ kind: "hold", frame: 0, dur: 0 }] };
}

// Everything that sits inside `containerId`, plus the edges between those boxes.
function insideIds(frame, containerId) {
  const c = frame.elements.find((e) => e.id === containerId);
  const within = (e) => e.x >= c.x - 1 && e.y >= c.y - 1 && e.x + e.w <= c.x + c.w + 1 && e.y + e.h <= c.y + c.h + 1;
  const boxes = new Set(frame.elements.filter((e) => e.kind !== "edge" && e.kind !== "elabel" && within(e)).map((e) => e.id));
  const edges = frame.elements.filter((e) => e.kind === "edge" && e.id.split(">").every((end) => boxes.has(end))).map((e) => e.id);
  return [...boxes, ...edges, ...edges.map((id) => `${id}#n`)];
}

function underCamera(frame, keep, cam) {
  const ids = new Set(keep);
  const map = (p) => ({ x: p.x * cam.s + cam.tx, y: p.y * cam.s + cam.ty });
  const elements = frame.elements
    .filter((e) => ids.has(e.id))
    .map((e) =>
      e.kind === "edge"
        ? { ...e, points: e.points.map(map), sw: e.sw * cam.s }
        : { ...e, ...map(e), w: e.w * cam.s, h: e.h * cam.s, fs: e.fs * cam.s },
    );
  return { ...frame, elements };
}

/** overview → expand two areas → zoom onto one → enter it (border bands appear). */
export function transitionData(overview, expanded, focus, targetId, targetName) {
  const keep = insideIds(expanded, targetId);
  const box = expanded.elements.find((e) => e.id === targetId);
  const cam = cameraOnto(box);
  const zoomed = underCamera(expanded, keep, cam);
  const timeline = [
    { kind: "hold", frame: 0, dur: 1.5, label: "1 overview" },
    { kind: "morph", from: 0, to: 1, dur: 2.4, label: "2 expand in place" },
    { kind: "hold", frame: 1, dur: 2.0, label: "2 expanded" },
    { kind: "camera", frame: 1, keep, to: cam, dur: 1.2, label: `3 zoom: ${targetName}` },
    { kind: "morph", from: 2, to: 3, dur: 2.0, label: "4 enter: border bands" },
    { kind: "hold", frame: 3, dur: 2.5, label: "4 focus" },
  ];
  return { static: false, frames: [overview, expanded, zoomed, focus], timeline };
}

const centre = (e) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });

/**
 * How much a morph disturbs the mental map: for boxes in both frames, the mean centre
 * displacement and the share of box pairs whose left/right or above/below order flips.
 */
export function mentalMap(from, to) {
  const b = new Map(to.elements.filter((e) => e.kind !== "edge" && e.kind !== "elabel").map((e) => [e.id, e]));
  const both = from.elements.filter((e) => b.has(e.id) && e.kind !== "edge" && e.kind !== "elabel");
  const moves = both.map((e) => Math.hypot(centre(e).x - centre(b.get(e.id)).x, centre(e).y - centre(b.get(e.id)).y));
  let [pairs, flips] = [0, 0];
  for (let i = 0; i < both.length; i++) {
    for (let j = i + 1; j < both.length; j++) {
      const [a0, b0, a1, b1] = [centre(both[i]), centre(both[j]), centre(b.get(both[i].id)), centre(b.get(both[j].id))];
      const flipped = (u, v) => Math.abs(u) > 4 && Math.abs(v) > 4 && Math.sign(u) !== Math.sign(v);
      pairs++;
      if (flipped(b0.x - a0.x, b1.x - a1.x) || flipped(b0.y - a0.y, b1.y - a1.y)) flips++;
    }
  }
  const mean = moves.length ? moves.reduce((s, m) => s + m, 0) / moves.length : 0;
  return { persisting: both.length, meanMovePx: Math.round(mean), orderFlips: `${flips}/${pairs}` };
}

// Scenes (layout units) to frames (frame px), and the level-transition clip's timeline.
import { LIMITS, cameraOnto, fitTransform, toScreen } from "./scene.mjs";
import { checkFrame, mentalMap } from "./rules.mjs";

export { mentalMap };

/** A design's static frame: the scene fitted into the frame's content area, with every rule checked. */
export function frameOf(scene, prev = null) {
  const t = fitTransform(scene.width, scene.height);
  const elements = toScreen(scene.elements, t);
  const frame = { name: scene.name, title: scene.title, subtitle: scene.subtitle, fit: +t.s.toFixed(3), k: scene.k ?? null, open: scene.open ?? null, elisions: scene.elisions ?? [], fallbacks: scene.fallbacks ?? [], elements };
  const checks = { pillsDropped: scene.pillsDropped ?? 0, headersMoved: scene.headersMoved ?? null, ...checkFrame(frame, LIMITS, prev) };
  return { ...frame, checks };
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

const PROXY = /^(top|bot):/;

/**
 * The frame as a viewer tracks it: a border proxy is the box it stands for (`top:area:x` is
 * `area:x`, `top:pkg-id` is `pkg:pkg-id`), an area in both bands counts once at its first proxy,
 * and the bands themselves are frame furniture, not boxes. For mentalMap, not for the rules.
 */
export function asTracked(frame) {
  const seen = new Set();
  const elements = [];
  for (const e of frame.elements) {
    if (e.kind === "band" || e.kind === "edge" || e.kind === "elabel") continue;
    const bare = e.id.replace(PROXY, "");
    const id = PROXY.test(e.id) && !/^(area|pkg|more|file):/.test(bare) ? `pkg:${bare}` : bare;
    if (seen.has(id)) continue;
    seen.add(id);
    elements.push({ ...e, id });
  }
  return { ...frame, elements };
}

/**
 * The ladder D2 → D4 → D5. With `zoom`, D2 → D4 is a camera move that carries the area card onto
 * the place D4 draws that area's container, so the box the viewer watches does not jump; without
 * it, D2 → D4 is the same staged cross-step morph as D4 → D5.
 */
export function ladderData(overview, focus, pkg, targetId, targetName, zoom = true) {
  const steps = [{ kind: "hold", frame: 0, dur: 1.5, label: "D2 overview" }];
  const frames = [overview];
  let enter = { kind: "morph", from: 0, to: 1, dur: 2.4, label: `D2 → D4: enter ${targetName}` };
  if (zoom) {
    const card = overview.elements.find((e) => e.id === targetId);
    const area = focus.elements.find((e) => e.id === targetId);
    const cam = cameraOnto(card, { x: area.x, y: area.y, width: area.w, height: area.h });
    frames.push(underCamera(overview, [targetId], cam));
    steps.push({ kind: "camera", frame: 0, keep: [targetId], to: cam, dur: 1.4, label: `D2 → D4: zoom into ${targetName}` });
    enter = { kind: "morph", from: 1, to: 2, dur: 1.8, label: `D2 → D4: enter ${targetName}` };
  }
  frames.push(focus, pkg);
  const [d4, d5] = [frames.length - 2, frames.length - 1];
  steps.push(enter, { kind: "hold", frame: d4, dur: 2.5, label: "D4 area focus" }, { kind: "morph", from: d4, to: d5, dur: 2.4, label: "D4 → D5: enter package" }, { kind: "hold", frame: d5, dur: 2.5, label: "D5 package focus" });
  return { static: false, frames, timeline: steps };
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

// Browser side of the l1-protos player: draws keyframes (screen-px scenes) into a 1920x1080
// SVG, tweens between them on a staged timeline, and measures what a frame shows.
/* global document, window, requestAnimationFrame, location */
const DATA = JSON.parse(document.getElementById("data").textContent);
const BOX_KINDS = new Set(["box", "container", "tile", "chip"]);
const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (v) => (v < 0.5 ? 2 * v * v : 1 - (-2 * v + 2) ** 2 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const toneAttr = (e) => (e.tone === undefined ? "" : ` data-tone="${e.tone}"`);

function pathD(points) {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}

function rectSvg(e, op) {
  const rx = e.kind === "chip" ? 18 : e.kind === "band" ? 0 : 6;
  return `<rect class="r ${e.kind}" data-id="${esc(e.id)}"${toneAttr(e)} x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="${rx}" style="--r:${(Math.min(e.w, e.h) / 2).toFixed(1)}px" opacity="${op}"/>`;
}

// Pills and chips centre their one line: a proportional face runs narrower than the box allows.
const CENTRED = new Set(["chip", "elabel"]);

function textSvg(e, op) {
  const s = e.fs / 24;
  const centred = CENTRED.has(e.kind) && e.lines.length === 1;
  const anchor = centred ? ' text-anchor="middle"' : "";
  return e.lines
    .map((line, i) => {
      const [x, y] = [centred ? e.x + e.w / 2 : e.x + 14 * s, e.y + 14 * s + e.fs * 0.8 + i * 30 * s];
      const cls = `lbl ${e.kind}${i === 0 ? " head" : ""}`;
      return `<text class="${cls}" data-box="${esc(e.id)}"${toneAttr(e)}${anchor} x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${e.fs.toFixed(2)}" opacity="${op}">${esc(line)}</text>`;
    })
    .join("");
}

function edgeSvg(e, op) {
  return `<path class="edge ${e.cls ?? ""}" data-id="${esc(e.id)}" d="${pathD(e.points)}" stroke-width="${e.sw.toFixed(2)}" opacity="${op}" marker-end="url(#arrow)"/>`;
}

// Paint order: bands, containers, edges, boxes and pills on top, labels last.
function paint(items, cam) {
  const layer = (pred) => items.filter(([e, op]) => op > 0.005 && pred(e));
  const rects = (pred) => layer(pred).map(([e, op]) => rectSvg(e, op)).join("");
  const body = [
    rects((e) => e.kind === "band"),
    rects((e) => e.kind === "container"),
    layer((e) => e.kind === "edge").map(([e, op]) => edgeSvg(e, op)).join(""),
    rects((e) => e.kind !== "band" && e.kind !== "container" && e.kind !== "edge"),
    layer((e) => e.kind !== "edge").map(([e, op]) => textSvg(e, op)).join(""),
  ].join("");
  const g = document.getElementById("scene");
  g.setAttribute("transform", `translate(${cam.tx} ${cam.ty}) scale(${cam.s})`);
  g.innerHTML = body;
}

function setChrome(frame, stage) {
  document.getElementById("title").textContent = frame.title;
  document.getElementById("subtitle").textContent = frame.subtitle;
  document.getElementById("stage").textContent = stage ?? "";
}

const byId = (frame) => new Map(frame.elements.map((e) => [e.id, e]));
const sameEdge = (a, b) => JSON.stringify(a.points) === JSON.stringify(b.points);

function morphBox(a, b, q) {
  const keys = ["x", "y", "w", "h", "fs"];
  const out = { ...(q < 0.5 ? a : b) };
  for (const k of keys) out[k] = lerp(a[k], b[k], q);
  return out;
}

// Staged like GraphDiaries: old edges out, boxes move, new boxes in, new edges in.
function morphItems(A, B, p) {
  const [a, b] = [byId(A), byId(B)];
  const exit = 1 - ease(clamp(p / 0.25));
  const move = ease(clamp((p - 0.25) / 0.4));
  const enterBox = ease(clamp((p - 0.6) / 0.2));
  const enterEdge = ease(clamp((p - 0.8) / 0.2));
  const items = [];
  for (const [id, e] of a) {
    const t = b.get(id);
    if (!t) items.push([e, exit]);
    else if (e.kind === "edge" || e.kind === "elabel") {
      if (sameEdge(e, t) && e.kind === "edge") items.push([e, 1]);
      else items.push([e, exit], [t, enterEdge]);
    } else items.push([morphBox(e, t, move), 1]);
  }
  for (const [id, e] of b) if (!a.has(id)) items.push([e, e.kind === "edge" || e.kind === "elabel" ? enterEdge : enterBox]);
  return items;
}

function cameraItems(F, seg, p) {
  const keep = new Set(seg.keep);
  const fade = 1 - ease(clamp(p / 0.4));
  return F.elements.map((e) => [e, keep.has(e.id) ? 1 : fade]);
}

function lerpCam(a, b, q) {
  const s = Math.exp(lerp(Math.log(a.s), Math.log(b.s), q));
  // Interpolate the screen point under the target's centre so the zoom heads straight at it.
  const k = (s - a.s) / (b.s - a.s || 1);
  return { s, tx: lerp(a.tx, b.tx, b.s === a.s ? q : k), ty: lerp(a.ty, b.ty, b.s === a.s ? q : k) };
}

const ID_CAM = { s: 1, tx: 0, ty: 0 };

function segmentAt(t) {
  let start = 0;
  for (const seg of DATA.timeline) {
    if (t <= start + seg.dur) return { seg, p: seg.dur ? (t - start) / seg.dur : 1 };
    start += seg.dur;
  }
  const seg = DATA.timeline[DATA.timeline.length - 1];
  return { seg, p: 1 };
}

function render(t) {
  const { seg, p } = segmentAt(t);
  const F = DATA.frames;
  if (seg.kind === "hold") {
    paint(F[seg.frame].elements.map((e) => [e, 1]), ID_CAM);
    setChrome(F[seg.frame], seg.label);
  } else if (seg.kind === "camera") {
    paint(cameraItems(F[seg.frame], seg, p), lerpCam(ID_CAM, seg.to, ease(p)));
    setChrome(F[seg.frame], seg.label);
  } else {
    paint(morphItems(F[seg.from], F[seg.to], p), ID_CAM);
    setChrome(p < 0.5 ? F[seg.from] : F[seg.to], seg.label);
  }
}

function rectsHit(a, b) {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

function inside(inner, outer) {
  return inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
}

// What one frame shows, measured from the rendered DOM rather than the scene data.
function measure() {
  const view = { left: 0, top: 0, right: 1920, bottom: 1080 };
  const shown = (el) => +el.getAttribute("opacity") > 0.01 && rectsHit(el.getBoundingClientRect(), view);
  const rects = [...document.querySelectorAll("#scene rect.r")].filter(shown);
  const boxes = rects.filter((r) => [...r.classList].some((c) => BOX_KINDS.has(c)));
  const labels = [...document.querySelectorAll("#scene text.lbl")].filter(shown);
  const scale = document.getElementById("scene").getCTM().a;
  const lr = labels.map((l) => l.getBoundingClientRect());
  let overlaps = 0;
  for (let i = 0; i < lr.length; i++) for (let j = i + 1; j < lr.length; j++) if (rectsHit(lr[i], lr[j])) overlaps++;
  const boxRect = new Map(rects.map((r) => [r.dataset.id, r.getBoundingClientRect()]));
  const overflow = labels.filter((l, i) => !inside(lr[i], boxRect.get(l.dataset.box) ?? lr[i])).length;
  const px = labels.map((l) => +l.getAttribute("font-size") * scale);
  const offscreen = boxes.filter((b) => !inside(b.getBoundingClientRect(), view)).length;
  return {
    boxes: boxes.length,
    edges: [...document.querySelectorAll("#scene path.edge")].filter(shown).length,
    labels: labels.length,
    minLabelPx: px.length ? +Math.min(...px).toFixed(2) : null,
    labelOverlaps: overlaps,
    labelOverflow: overflow,
    boxesCutByFrame: offscreen,
  };
}

const duration = DATA.timeline.reduce((n, s) => n + s.dur, 0);
window.__duration = duration;
window.__seek = (t) => render(t);
window.__measure = measure;

function wireControls() {
  const [play, loop, scrub, time] = ["play", "loop", "scrub", "time"].map((id) => document.getElementById(id));
  let [t, last, playing] = [0, 0, !DATA.static];
  scrub.max = String(duration);
  const show = () => {
    render(t);
    scrub.value = String(t);
    time.textContent = `${t.toFixed(2)} / ${duration.toFixed(2)} s`;
  };
  play.onclick = () => {
    playing = !playing;
    play.textContent = playing ? "pause" : "play";
  };
  scrub.oninput = () => [t, playing, play.textContent] = [+scrub.value, false, "play"];
  const tick = (now) => {
    const dt = (now - (last || now)) / 1000;
    last = now;
    if (playing) t = t + dt > duration ? (loop.checked ? 0 : duration) : t + dt;
    show();
    requestAnimationFrame(tick);
  };
  play.textContent = playing ? "pause" : "play";
  requestAnimationFrame(tick);
}

if (new URLSearchParams(location.search).has("capture") || DATA.static) {
  document.body.classList.add("capture");
  render(Number(new URLSearchParams(location.search).get("t") ?? 0));
} else wireControls();

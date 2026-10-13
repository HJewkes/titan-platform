// Frame configuration and the limits derived from it. Nothing here is a hand constant: every
// pixel value comes from the frame, the font metrics and the fractions in frame-config.json.
// L1_FRAME_CONFIG points at a config file, L1_FRAME names one of its frames, L1_LABEL_PX
// overrides the derived label floor (the older size-comparison path).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG = path.join(HERE, "..", "frame-config.json");

export function loadConfig(file = process.env.L1_FRAME_CONFIG ?? DEFAULT_CONFIG) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Label font size in frame px: the larger of the frame-relative and the viewer-absolute floor. */
export function labelFloorPx(frame, cfg) {
  const { xHeightFraction, minViewerXHeightPx } = cfg.labelFloor;
  const xHeightPx = Math.max(xHeightFraction * frame.height, minViewerXHeightPx / frame.viewScale);
  return Math.ceil(xHeightPx / cfg.font.xHeight);
}

/** The content rectangle after safe-area margins and the title strip, in whole px. */
export function contentRect(frame, cfg) {
  const mx = Math.round(cfg.safeArea.x * frame.width);
  const my = Math.round(cfg.safeArea.y * frame.height);
  const top = Math.round((cfg.safeArea.y + cfg.safeArea.titleStrip) * frame.height);
  return { x: mx, y: top, width: frame.width - 2 * mx, height: frame.height - top - my };
}

/** Box, line and gap geometry in px for a label size `F`, from the em fractions in config. */
export function metricsFor(F, cfg) {
  const pad = cfg.spacing.boxPad * F;
  const line = cfg.font.lineHeight * F;
  return {
    font: F,
    char: cfg.font.advance * F,
    monoChar: (cfg.font.monoAdvance ?? cfg.font.advance) * F,
    line,
    pad,
    containerTop: 2 * pad + line,
    boxGap: cfg.spacing.boxGap * F,
    layerGap: cfg.spacing.layerGap * F,
    layerGapOverview: cfg.spacing.layerGapOverview * F,
    edgeGap: cfg.spacing.edgeGap * F,
    edgeNode: cfg.spacing.edgeNode * F,
    minGap: cfg.spacing.minGap * F,
    strokeBase: cfg.stroke.baseEm * F,
  };
}

/** Size of a box holding `lines` lines of at most `chars` characters. */
export function boxDims(m, chars, lines = 1) {
  return { w: Math.ceil(chars * m.char + 2 * m.pad), h: Math.ceil(lines * m.line + 2 * m.pad - 0.25 * m.font) };
}

// A grid of one-line boxes of `labelChars` characters: columns across the content width and
// rows down its height, each row separated by the layer gap the nested designs use.
function gridCapacity(content, m, cfg) {
  const box = boxDims(m, cfg.labelChars);
  const cols = Math.floor((content.width + m.boxGap) / (box.w + m.boxGap));
  const rows = Math.floor((content.height + m.layerGap) / (box.h + m.layerGap));
  return { cols, rows, boxes: cols * rows, box };
}

// Orthogonal routes run in the channels between rows and between columns, one lane per edge
// gap; every drawn edge occupies at least one lane, so the lane total bounds the edge count.
function laneCapacity(grid, m) {
  const rowLanes = Math.max(0, grid.rows - 1) * Math.floor(m.layerGap / m.edgeGap);
  const colLanes = (grid.cols + 1) * Math.floor(m.boxGap / m.edgeGap);
  return rowLanes + colLanes;
}

/**
 * Everything a design needs to know about one frame: the label floor, the content area, the
 * px metrics, the geometric capacity and the caps (the smaller of capacity and the cognitive
 * ceiling). `labelPx` may be overridden, which is how the 24/32/40 comparison was built.
 */
export function deriveLimits(frame, cfg, labelPx = null) {
  const F = labelPx ?? labelFloorPx(frame, cfg);
  const content = contentRect(frame, cfg);
  const m = metricsFor(F, cfg);
  const grid = gridCapacity(content, m, cfg);
  const lanes = laneCapacity(grid, m);
  const caps = {
    groups: Math.min(cfg.cognitive.groups, grid.boxes),
    boxes: Math.min(cfg.cognitive.boxes, grid.boxes),
    labels: Math.min(cfg.cognitive.labels, grid.boxes),
    edges: Math.min(cfg.cognitive.edges, lanes),
    crossingsPerEdge: cfg.cognitive.crossingsPerEdge,
    unit: cfg.cognitive.unit,
  };
  const minStrokePx = Math.max(m.strokeBase, cfg.stroke.minViewerPx / frame.viewScale);
  return { frame, labelPx: F, xHeightPx: +(F * cfg.font.xHeight).toFixed(2), content, metrics: m, grid, lanes, caps, minStrokePx };
}

/**
 * Per-design top-k upper bounds from the box cap alone (the layout may fit fewer):
 * D3 opens `open` of `groups` areas, each costing a container and a "+N more" tile;
 * D4 and D5 spend one container, one tile and one box per proxy chip.
 */
export function topKBounds(caps, { groups, open = 2, proxies = 0, filesMax = 10 }) {
  const d3 = open > 0 ? Math.floor((caps.boxes - (groups - open) - 2 * open) / open) : 0;
  const focus = caps.boxes - 2 - proxies;
  return { d3: Math.max(0, d3), d4: Math.max(0, focus), d5: Math.max(0, Math.min(filesMax, focus)) };
}

// The titan themes draw labels in their own face, so the floor derives from its x-height. The
// advance and line pitch stay the config's layout budget unless `faceAdvance` (or
// L1_FACE_ADVANCE=1) is on: then box labels budget the face's measured average advance, and
// the roles the theme draws in its mono token (file paths, pills) keep the config's advance.
const THEME_FONT = { dark: "titan", light: "titan" };

function faceAdvanceOn(cfg) {
  return process.env.L1_FACE_ADVANCE ? process.env.L1_FACE_ADVANCE === "1" : cfg.faceAdvance === true;
}

/** L1_LABEL_FACE=pinned keeps map labels in the config's pinned face under a titan theme's colours. */
export const pinnedLabelFace = () => process.env.L1_LABEL_FACE === "pinned";

/** `cfg` with the font metrics of the face L1_THEME draws labels in. */
export function themedConfig(cfg, theme = process.env.L1_THEME) {
  const face = pinnedLabelFace() ? null : cfg.themeFonts?.[THEME_FONT[theme]];
  if (!face) return cfg;
  const { measuredAdvance, ...metrics } = face;
  const font = { ...cfg.font, ...metrics };
  if (faceAdvanceOn(cfg) && measuredAdvance) Object.assign(font, { advance: measuredAdvance, monoAdvance: cfg.font.advance });
  return { ...cfg, font };
}

/** The frame selected by L1_FRAME (default 1080p), with the label floor from L1_LABEL_PX if set. */
export function currentLimits(cfg = themedConfig(loadConfig())) {
  const name = process.env.L1_FRAME ?? "1080p";
  const frame = cfg.frames[name];
  if (!frame) throw new Error(`unknown frame ${name}; config has ${Object.keys(cfg.frames).join(", ")}`);
  const override = process.env.L1_LABEL_PX ? Number(process.env.L1_LABEL_PX) : null;
  return { name, cfg, ...deriveLimits({ ...frame, name }, cfg, override) };
}

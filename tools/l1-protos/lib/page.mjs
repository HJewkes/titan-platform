// One self-contained HTML page per design or clip: the SVG frame at the configured size with
// a fixed scale reference (bars at 24/32/40 px and at the derived floor, plus a px ruler), the
// data inlined, and player.js inlined. `?capture` hides the controls for screenshots.
// The label font is pinned to a file from config under its own family name, so a missing
// file shows up as a fallback font in the measurements rather than a silent substitution.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLAYER = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "player.js"), "utf8");
export const LABEL_FAMILY = "L1Label";

/** What the page needs to draw the frame chrome and place labels, all from the derived limits. */
export function frameInfo(limits, cfg) {
  const { frame, content, labelPx, xHeightPx } = limits;
  const reference = [...new Set([24, 32, 40, labelPx])].sort((a, b) => a - b);
  return { name: frame.name, width: frame.width, height: frame.height, viewScale: frame.viewScale, content, labelPx, xHeightPx, reference, chrome: Math.min(frame.width / 1920, frame.height / 1080), font: cfg.font, padEm: cfg.spacing.boxPad, lineEm: cfg.font.lineHeight };
}

function css(frame) {
  const font = frame.font;
  return `
@font-face{font-family:"${LABEL_FAMILY}";src:url("${pathToFileURL(font.file).href}") format("truetype");font-weight:normal}
@font-face{font-family:"${LABEL_FAMILY}";src:url("${pathToFileURL(font.boldFile).href}") format("truetype");font-weight:bold}
body{margin:0;background:#2b2f36;font-family:"${LABEL_FAMILY}",monospace;color:#ddd}
.wrap{width:min(100vw,${frame.width}px)} svg.frame{width:100%;height:auto;display:block;background:#fff}
body.capture .wrap{width:${frame.width}px} body.capture .controls{display:none}
.controls{display:flex;gap:12px;align-items:center;padding:8px 12px;font-size:16px}
.controls input[type=range]{flex:1}
text{font-family:"${LABEL_FAMILY}",monospace;fill:#1b2a41}
.r.box{fill:#fff;stroke:#4a6fa5;stroke-width:2}.r.container{fill:#f3f7fd;stroke:#4a6fa5;stroke-width:1.5}
.r.tile{fill:#f7f7f7;stroke:#888;stroke-width:1.5;stroke-dasharray:6 4}.r.chip{fill:#efe9f8;stroke:#7d5ba6;stroke-width:2}
.r.band{fill:#f6f2fb}.r.elabel{fill:#fff;stroke:#c0392b;stroke-width:1}
.lbl.head{font-weight:bold}.lbl.tile{fill:#555}.lbl.band{fill:#7d5ba6;font-style:italic}.lbl.elabel{fill:#c0392b}
.lbl.chip{fill:#4b2f73}
path.edge{fill:none;stroke:#c0392b;stroke-linejoin:round}
.chrome{fill:#1b2a41}.ref{fill:#0a7d3c}.tick{stroke:#0a7d3c;stroke-width:1}
`;
}

function ruler(frame) {
  const { width, height, chrome } = frame;
  const y = height - Math.round(28 * chrome);
  const parts = [`<line class="tick" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`];
  for (let x = 0; x <= width; x += 100) {
    const h = x % 500 === 0 ? 14 : 7;
    parts.push(`<line class="tick" x1="${x}" y1="${y}" x2="${x}" y2="${y - h}"/>`);
    if (x % 500 === 0 && x < width) parts.push(`<text class="ref" x="${x + 4}" y="${y + Math.round(24 * chrome)}" font-size="${Math.round(24 * chrome)}">${x}px</text>`);
  }
  return parts.join("");
}

// Bars exactly as tall as each reference size, bottoms aligned beside sample text at that size,
// plus one bar for the floor's x-height: a reader can compare any map label against the size it
// is being judged at. Right-aligned in the title strip.
function scaleReference(frame) {
  const base = frame.content.y - Math.round(frame.content.y / 3);
  const items = frame.reference.map((px) => ({ px, text: `${px}px`, w: 8 + 14 + Math.ceil(px * 0.6 * 4) + 24 }));
  items.push({ px: frame.xHeightPx, text: "x", w: 8 + 14 + Math.ceil(frame.labelPx * 0.6) + 24, fs: frame.labelPx });
  let x = frame.width - 24 - items.reduce((n, i) => n + i.w, 0);
  const parts = items.map((i) => {
    const fs = i.fs ?? i.px;
    const part = `<rect x="${x}" y="${(base - i.px).toFixed(1)}" width="8" height="${i.px}" fill="#0a7d3c"/>
<text class="ref" x="${x + 14}" y="${base}" font-size="${fs}">${i.text}</text>`;
    x += i.w;
    return part;
  });
  return `${parts.join("\n")}
<text class="ref" x="${frame.width - 24}" y="${base + Math.round(36 * frame.chrome)}" font-size="${Math.round(24 * frame.chrome)}" text-anchor="end" id="stage"></text>`;
}

function frameSvg(frame) {
  const { width, height, chrome } = frame;
  return `<svg class="frame" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#c0392b"/></marker></defs>
<rect width="${width}" height="${height}" fill="#fff"/>
<text class="chrome" id="title" x="24" y="${Math.round(40 * chrome)}" font-size="${Math.round(30 * chrome)}" font-weight="bold"></text>
<text class="chrome" id="subtitle" x="24" y="${Math.round(78 * chrome)}" font-size="${Math.round(24 * chrome)}"></text>
${scaleReference(frame)}
<g id="scene"></g>
${ruler(frame)}
</svg>`;
}

/** The page for `data` = { frame, frames, timeline, static }. */
export function pageHtml(title, data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css(data.frame)}</style></head>
<body><div class="wrap">${frameSvg(data.frame)}
<div class="controls"><button id="play">play</button><label><input type="checkbox" id="loop" checked> loop</label>
<input type="range" id="scrub" min="0" step="0.01" value="0"><span id="time"></span></div></div>
<script id="data" type="application/json">${json}</script>
<script>${PLAYER}</script></body></html>`;
}

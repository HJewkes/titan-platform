// One self-contained HTML page per design or clip: the 1920x1080 SVG frame with a fixed
// scale reference (a 24 px label beside a 24 px bar, and a px ruler), the data inlined,
// and player.js inlined. `?capture` hides the controls for screenshots.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { themeStyles } from "./theme.mjs";

const PLAYER = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "player.js"), "utf8");

const LAYOUT_CSS = `
.wrap{width:min(100vw,1920px)} svg.frame{width:100%;height:auto;display:block}
body{margin:0} body.capture .wrap{width:1920px} body.capture .controls{display:none}
.controls{display:flex;gap:12px;align-items:center;padding:8px 12px;font-size:16px}
.controls input[type=range]{flex:1}
`;

function ruler() {
  const parts = [`<line class="tick" x1="0" y1="1052" x2="1920" y2="1052"/>`];
  for (let x = 0; x <= 1920; x += 100) {
    const h = x % 500 === 0 ? 14 : 7;
    parts.push(`<line class="tick" x1="${x}" y1="1052" x2="${x}" y2="${1052 - h}"/>`);
    if (x % 500 === 0 && x < 1920) parts.push(`<text class="ref" x="${x + 4}" y="1076" font-size="24">${x}px</text>`);
  }
  return parts.join("");
}

// Bars exactly 24, 32 and 40 px tall, each beside sample text at that size, bottoms aligned: a
// reader can compare any map label against the size it is being judged at.
const REFERENCE_SIZES = [24, 32, 40];

function scaleReference() {
  let x = 1330;
  const parts = REFERENCE_SIZES.map((px) => {
    const part = `<rect class="ref" x="${x}" y="${64 - px}" width="8" height="${px}"/>
<text class="ref" x="${x + 14}" y="${64 - Math.round(px * 0.2)}" font-size="${px}">${px}px</text>`;
    x += 14 + Math.ceil(px * 0.6 * 4) + 24;
    return part;
  });
  return `${parts.join("\n")}
<text class="ref" x="1896" y="100" font-size="24" text-anchor="end" id="stage"></text>`;
}

function frameSvg() {
  return `<svg class="frame" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" orient="auto-start-reverse"><path class="arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>
<rect class="bg" width="1920" height="1080"/>
<text class="chrome" id="title" x="24" y="40" font-size="30" font-weight="bold"></text>
<text class="chrome" id="subtitle" x="24" y="78" font-size="24"></text>
${scaleReference()}
<g id="scene"></g>
${ruler()}
</svg>`;
}

/** The page for `data` = { frames, timeline, static }, styled by L1_THEME (default plain). */
export function pageHtml(title, data) {
  const { css, htmlClass } = themeStyles(process.env.L1_THEME ?? "plain");
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html><html class="${htmlClass}"><head><meta charset="utf-8"><title>${title}</title><style>${LAYOUT_CSS}${css}</style></head>
<body><div class="wrap">${frameSvg()}
<div class="controls"><button id="play">play</button><label><input type="checkbox" id="loop" checked> loop</label>
<input type="range" id="scrub" min="0" step="0.01" value="0"><span id="time"></span></div></div>
<script id="data" type="application/json">${json}</script>
<script>${PLAYER}</script></body></html>`;
}

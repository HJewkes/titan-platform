// One self-contained HTML page per design or clip: the 1920x1080 SVG frame with a fixed
// scale reference (a 24 px label beside a 24 px bar, and a px ruler), the data inlined,
// and player.js inlined. `?capture` hides the controls for screenshots.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLAYER = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "player.js"), "utf8");

const CSS = `
body{margin:0;background:#2b2f36;font-family:"DejaVu Sans Mono",Menlo,monospace;color:#ddd}
.wrap{width:min(100vw,1920px)} svg.frame{width:100%;height:auto;display:block;background:#fff}
body.capture .wrap{width:1920px} body.capture .controls{display:none}
.controls{display:flex;gap:12px;align-items:center;padding:8px 12px;font-size:16px}
.controls input[type=range]{flex:1}
text{font-family:"DejaVu Sans Mono",Menlo,monospace;fill:#1b2a41}
.r.box{fill:#fff;stroke:#4a6fa5;stroke-width:2}.r.container{fill:#f3f7fd;stroke:#4a6fa5;stroke-width:1.5}
.r.tile{fill:#f7f7f7;stroke:#888;stroke-width:1.5;stroke-dasharray:6 4}.r.chip{fill:#efe9f8;stroke:#7d5ba6;stroke-width:2}
.r.band{fill:#f6f2fb}.r.elabel{fill:#fff;stroke:#c0392b;stroke-width:1}
.lbl.head{font-weight:bold}.lbl.tile{fill:#555}.lbl.band{fill:#7d5ba6;font-style:italic}.lbl.elabel{fill:#c0392b}
.lbl.chip{fill:#4b2f73}
path.edge{fill:none;stroke:#c0392b;stroke-linejoin:round}
.chrome{fill:#1b2a41}.ref{fill:#0a7d3c}.tick{stroke:#0a7d3c;stroke-width:1}
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

// A 24 px label next to a bar exactly 24 px tall: a reader can compare any map label against it.
function scaleReference() {
  return `<rect x="1560" y="20" width="10" height="24" fill="#0a7d3c"/>
<text class="ref" x="1578" y="39" font-size="24">24px reference</text>
<text class="ref" x="1896" y="76" font-size="24" text-anchor="end" id="stage"></text>`;
}

function frameSvg() {
  return `<svg class="frame" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#c0392b"/></marker></defs>
<rect width="1920" height="1080" fill="#fff"/>
<text class="chrome" id="title" x="24" y="40" font-size="30" font-weight="bold"></text>
<text class="chrome" id="subtitle" x="24" y="78" font-size="24"></text>
${scaleReference()}
<g id="scene"></g>
${ruler()}
</svg>`;
}

/** The page for `data` = { frames, timeline, static }. */
export function pageHtml(title, data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head>
<body><div class="wrap">${frameSvg()}
<div class="controls"><button id="play">play</button><label><input type="checkbox" id="loop" checked> loop</label>
<input type="range" id="scrub" min="0" step="0.01" value="0"><span id="time"></span></div></div>
<script id="data" type="application/json">${json}</script>
<script>${PLAYER}</script></body></html>`;
}

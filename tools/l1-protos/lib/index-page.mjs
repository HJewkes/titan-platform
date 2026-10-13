// index.html: every design's frame side by side at true 1080 scale (1 image px = 1 screen px,
// scroll sideways), a "fit" toggle for an overview, the measured table and the clip.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function verdict(m, cap) {
  const ok = m.boxes <= cap.boxes && m.edges <= cap.edges && m.minLabelPx >= cap.labelPx && m.labelOverlaps === 0;
  return ok ? "within cap" : "OVER cap";
}

function row(r, cap) {
  const cells = [r.name, r.boxes, r.edges, r.labels, r.minLabelPx, r.labelOverlaps, r.labelOverflow, r.fit, verdict(r, cap)];
  return `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
}

function stageRow(s, cap) {
  const cells = [s.label, s.boxes, s.edges, s.labels, s.minLabelPx, s.labelOverlaps, s.labelOverflow, "", verdict(s, cap)];
  return `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
}

function card(r) {
  return `<figure><figcaption>${esc(r.title)} — <a href="${r.name}/frame.html">page</a></figcaption><img src="${r.name}/frame.png" width="1920" height="1080" alt="${esc(r.name)}"></figure>`;
}

export function indexHtml(results, cap) {
  const designs = results.filter((r) => r.name !== "motion");
  const clip = results.find((r) => r.name === "motion")?.clip;
  const head = ["frame", "boxes", "edges", "labels", "min label px", "label overlaps", "label overflow", "fit scale", "verdict"];
  return `<!doctype html><html><head><meta charset="utf-8"><title>L1 legibility designs</title><style>
body{font-family:system-ui,sans-serif;margin:16px;background:#f4f4f4}
.row{display:flex;gap:24px;overflow-x:auto;padding-bottom:12px}figure{margin:0;flex:none}
figure img{display:block;border:1px solid #999;background:#fff}body.fit figure img{width:880px;height:auto}
body.fit .row{flex-wrap:wrap}table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #bbb;padding:4px 8px;text-align:right}
td:first-child{text-align:left}video{width:960px;border:1px solid #999}</style></head><body>
<h1>L1 legibility: designs within a cap</h1>
<p>Cap: ≤ ${cap.boxes} labelled boxes, ≤ ${cap.edges} edges, labels ≥ ${cap.labelPx} px in a 1920x1080 frame, ≤ ${cap.topGroups} top-level groups.
Images below are at true 1080 scale (scroll sideways). <button onclick="document.body.classList.toggle('fit')">toggle fit</button></p>
<table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${designs.map((r) => row(r, cap)).join("")}
${(clip?.stages ?? []).map((s) => stageRow(s, cap)).join("")}</table>
<div class="row">${designs.map(card).join("")}</div>
<h2>Level transition (expand, then zoom)</h2>
<p><a href="motion/transition.html">interactive player (play, loop, scrubber)</a></p>
<p>Mental map: ${esc(JSON.stringify(results.find((r) => r.name === "motion")?.mental ?? {}))}</p>
<video src="motion/transition.mp4" controls loop muted></video>
</body></html>`;
}

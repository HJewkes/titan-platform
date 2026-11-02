import { depthOf, goalOf, GOALS, loopById, NODES, SELECTED, stateOf } from "./data.mjs";
import { esc, page, SCALES, STATE_CSS, STATE_LABEL, stateClass, statusPill } from "./common.mjs";

const LEDE = "Read-only. A not-started node with an unfinished dependency is locked; ⚠ marks high churn with no done-when progress.";

/** Columns by dependency depth, rows by goal, so every direction draws the same graph at its own size. */
function positions({ w, h, colGap, rowGap }) {
  const columns = new Map();
  for (const item of NODES) columns.set(depthOf(item), [...(columns.get(depthOf(item)) ?? []), item]);
  const at = new Map();
  for (const [col, items] of columns) items.forEach((item, row) => at.set(item.id, { x: col * (w + colGap), y: row * (h + rowGap) }));
  const rows = Math.max(...[...columns.values()].map((items) => items.length));
  return { at, width: columns.size * (w + colGap) - colGap, height: rows * (h + rowGap) - rowGap };
}

function edges(at, { w, h }) {
  return NODES.flatMap((item) =>
    item.dependsOn.map((dep) => {
      const a = at.get(dep);
      const b = at.get(item.id);
      const [x1, y1, x2, y2] = [a.x + w, a.y + h / 2, b.x, b.y + h / 2];
      const mid = (x1 + x2) / 2;
      return `<path d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}"/>`;
    }),
  ).join("");
}

function graph(size, renderNode) {
  const { at, width, height } = positions(size);
  const nodes = NODES.map((item) => {
    const { x, y } = at.get(item.id);
    const cls = `node ${stateClass(stateOf(item))}${item.churn.highChurnNoProgress ? " churn" : ""}${item.id === SELECTED ? " selected" : ""}`;
    return `<div class="${cls}" style="left:${x}px;top:${y}px;width:${size.w}px;height:${size.h}px">${renderNode(item)}</div>`;
  });
  return `<div class="scroll"><div class="plot" style="width:${width}px;height:${height}px"><svg class="edges" width="${width}" height="${height}">${edges(at, size)}</svg>${nodes.join("")}</div></div>`;
}

const legend = () =>
  `<div class="legend">${Object.entries(STATE_LABEL).map(([state, label]) => `<span class="${stateClass(state)}"><i></i>${label}</span>`).join("")}<span class="churn-key">⚠ high churn</span></div>`;

const selected = () => NODES.find((item) => item.id === SELECTED);
const churnLine = (item) => `${item.churn.closed14d} closed in 14 days · ${item.churn.openNow} open now · done-when moved: ${item.churn.doneWhenMoved ? "yes" : "no"}`;
const panelLoops = (item) =>
  item.loops.map((id) => loopById(id)).map((loop) => `<li><a>${esc(loop.title)}</a>${statusPill(loop.status)}</li>`).join("");

const GRAPH_CSS = `
${STATE_CSS}
.scroll{overflow-x:auto;max-width:100%}
.layout>*{min-width:0}
.plot{position:relative}
.edges{position:absolute;inset:0;fill:none;stroke:var(--color-hairline-strong);stroke-width:1.5}
.node{position:absolute;display:flex;border:1px solid var(--color-divider);background:var(--color-surface-base);color:var(--color-text-primary)}
.node.s-not-started{border-style:dashed;border-color:var(--color-border-prominent)}
.node.s-locked{color:var(--color-text-tertiary)}
.node.churn{border-color:var(--color-status-warning)}
.node.selected{outline:2px solid var(--color-border-focus);outline-offset:2px}
.legend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:var(--fs-meta);color:var(--color-text-secondary)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:3px;background:var(--state)}
.legend .s-not-started i{background:none;border:1px dashed var(--color-border-prominent)}
.panel ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.panel li{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.panel a{color:var(--color-text-link)}
`;

const top = () => `<header class="head"><h1>Tech tree</h1><p class="lede">${LEDE}</p></header><div class="tabs"><span class="on">Dependencies</span><span>Goal lanes</span></div>`;

const AIRY_CSS = `${GRAPH_CSS}
main{padding:48px 40px 64px}
.head{margin-bottom:24px}.tabs{margin-bottom:32px}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:40px;align-items:start}
.legend{margin-bottom:24px}
.node{flex-direction:column;justify-content:center;gap:4px;padding:0 16px 0 20px;border-radius:12px}
.node::before{content:"";position:absolute;left:8px;top:50%;width:6px;height:6px;margin-top:-3px;border-radius:50%;background:var(--state)}
.node b{font-size:var(--fs-title);font-weight:var(--title-weight);line-height:1.2}
.panel{padding:28px;border-radius:14px;background:var(--color-surface-base);display:flex;flex-direction:column;gap:16px}
.panel h2{font-size:var(--fs-section);font-family:var(--font-family-heading),system-ui,sans-serif;font-weight:600;margin:0}
.panel p{margin:0;color:var(--color-text-secondary)}
@media (max-width:600px){main{padding:28px 16px 48px}.layout{grid-template-columns:1fr;gap:28px}}
`;

function airy() {
  const size = { w: 240, h: 76, colGap: 80, rowGap: 22 };
  const node = (item) => `<b>${item.churn.highChurnNoProgress ? "⚠ " : ""}${esc(item.title)}</b><span class="meta">${item.churn.closed14d} closed · 14d</span>`;
  const item = selected();
  const panel = `<aside class="panel"><span class="meta">${goalOf(item.goal).title}</span><h2>${esc(item.title)}</h2><div>${statePill(item)}</div>
<p>Done when: ${esc(item.doneWhen)}</p><span class="meta">${churnLine(item)}</span><ul>${panelLoops(item)}</ul></aside>`;
  const body = `<main>${top()}<div class="layout"><div>${legend()}${graph(size, node)}</div>${panel}</div></main>`;
  return page({ title: "Tree · airy", scale: SCALES.roomy, css: AIRY_CSS, view: "tree", body });
}

const statePill = (item) => `<span class="pill dot ${stateClass(stateOf(item))}" style="color:var(--state);background:var(--state-bg)">${STATE_LABEL[stateOf(item)]}</span>`;

const CARDS_CSS = `${GRAPH_CSS}
main{padding:40px 32px 56px}
.head{margin-bottom:20px}.tabs{margin-bottom:24px}
.goals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:28px}
.goal{padding:18px;border-radius:12px;background:var(--color-surface-base);box-shadow:var(--lift-1);display:flex;flex-direction:column;gap:10px}
.goal h2{font-size:var(--fs-title);font-weight:var(--title-weight);margin:0}
.bar{display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--color-interactive-selected)}
.bar i{display:block;background:var(--state)}
.board{padding:24px;border-radius:14px;background:var(--color-surface-base);box-shadow:var(--lift-1)}
.legend{margin-bottom:20px}
.node{flex-direction:column;justify-content:center;gap:2px;padding:0 12px 0 16px;border-radius:10px;background:var(--color-surface-raised);border-color:transparent;overflow:hidden}
.node::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--state)}
.node.s-not-started{border-color:var(--color-border-prominent)}
.node.churn{border-color:var(--color-status-warning)}
.node .meta{font-size:11px}
.node b{font-size:var(--fs-body);font-weight:var(--title-weight);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.panel{margin-top:24px;padding:24px;border-radius:14px;background:var(--color-surface-base);box-shadow:var(--lift-1);display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:16px 32px}
.panel h2{font-size:var(--fs-section);font-family:var(--font-family-heading),system-ui,sans-serif;margin:0 0 8px}
.panel p{margin:0 0 8px;color:var(--color-text-secondary)}
.panel h3{font-size:var(--fs-meta);text-transform:uppercase;letter-spacing:0.08em;color:var(--color-text-tertiary);margin:0 0 10px}
@media (max-width:600px){main{padding:24px 12px 40px}.goals{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.goal{padding:14px}.board{padding:14px}.panel{grid-template-columns:1fr;padding:18px}}
`;

function goalCard(goal) {
  const items = NODES.filter((item) => item.goal === goal.id);
  const count = (state) => items.filter((item) => stateOf(item) === state).length;
  const bar = ["done", "in progress"].map((state) => `<i class="${stateClass(state)}" style="width:${(100 * count(state)) / items.length}%"></i>`).join("");
  return `<div class="goal"><h2>${goal.title}</h2><div class="bar">${bar}</div><span class="meta">${count("done")} of ${items.length} done · ${count("in progress")} in progress</span></div>`;
}

function cards() {
  const size = { w: 224, h: 60, colGap: 64, rowGap: 14 };
  const node = (item) => `<span class="meta">${goalOf(item.goal).title}</span><b>${item.churn.highChurnNoProgress ? "⚠ " : ""}${esc(item.title)} · ${item.churn.closed14d}</b>`;
  const item = selected();
  const panel = `<section class="panel"><div><span class="meta">${goalOf(item.goal).title}</span><h2>${esc(item.title)}</h2><p>${statePill(item)}</p><p>Done when: ${esc(item.doneWhen)}</p><span class="meta">${churnLine(item)}</span></div>
<div><h3>Loops that move it</h3><ul>${panelLoops(item)}</ul></div></section>`;
  const body = `<main>${top()}<div class="goals">${GOALS.map(goalCard).join("")}</div><div class="board">${legend()}${graph(size, node)}</div>${panel}</main>`;
  return page({ title: "Tree · grouped cards", scale: SCALES.roomy, css: CARDS_CSS, view: "tree", body });
}

const TABLE_CSS = `${GRAPH_CSS}
main{padding:32px 32px 48px}
.head{margin-bottom:16px}.tabs{margin-bottom:16px}
.board{border:1px solid var(--color-divider);border-radius:10px;padding:16px}
.legend{margin-bottom:14px}
.node{align-items:center;gap:8px;padding:0 10px;border-radius:6px;font-size:var(--fs-meta);white-space:nowrap}
.node::before{content:"";flex:none;width:8px;height:8px;border-radius:2px;background:var(--state)}
.node b{font-weight:600;overflow:hidden;text-overflow:ellipsis}
.node .n{margin-left:auto;color:var(--color-text-tertiary);font-family:var(--font-family-mono)}
.panel{margin-top:16px;border:1px solid var(--color-divider);border-radius:10px;overflow:hidden}
.panel h2{margin:0;padding:10px 16px;font-size:var(--fs-meta);text-transform:uppercase;letter-spacing:0.08em;background:var(--color-surface-base)}
.panel dl{display:grid;grid-template-columns:140px minmax(0,1fr);margin:0}
.panel dt,.panel dd{margin:0;padding:10px 16px;border-top:1px solid var(--color-hairline-subtle)}
.panel dt{color:var(--color-text-tertiary);font-size:var(--fs-meta)}
@media (max-width:600px){main{padding:20px 12px 40px}.board{padding:10px}.panel dl{grid-template-columns:96px minmax(0,1fr)}}
`;

function table() {
  const size = { w: 168, h: 34, colGap: 44, rowGap: 10 };
  const node = (item) => `<b>${item.churn.highChurnNoProgress ? "⚠ " : ""}${esc(item.title)}</b><span class="n">${item.churn.closed14d}</span>`;
  const item = selected();
  const panel = `<section class="panel"><h2>${esc(item.title)}</h2><dl><dt>State</dt><dd>${statePill(item)}</dd><dt>Goal</dt><dd>${goalOf(item.goal).title}</dd>
<dt>Done when</dt><dd>${esc(item.doneWhen)}</dd><dt>Churn</dt><dd>${churnLine(item)}</dd><dt>Loops</dt><dd><ul>${panelLoops(item)}</ul></dd></dl></section>`;
  const body = `<main>${top()}<div class="board">${legend()}${graph(size, node)}</div>${panel}</main>`;
  return page({ title: "Tree · compact", scale: SCALES.compact, css: TABLE_CSS, view: "tree", body });
}

export const TREE_DIRECTIONS = { airy, cards, table };

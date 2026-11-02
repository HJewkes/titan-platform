import { isStale, TIER_ROWS, tierOf } from "./data.mjs";
import { emphasisPill, esc, motionPill, moveSelect, page, refs, SCALES, sourcePill, statusPill } from "./common.mjs";

const LEDE = "Tiers are advisory: coordinators weigh them but choose freely. Drag a card to another tier, or use its Move to menu.";

const header = () => `<header class="head"><h1>Open loops</h1><p class="lede">${LEDE}</p></header>
<div class="filters"><span class="select">Any initiative</span><span class="select">Any status</span></div>`;

const vitals = (item) => [statusPill(item.status), motionPill(item, isStale(item)), emphasisPill(item), sourcePill(item)].join("");

const doneWhen = (item) => (item.doneWhen ? `<p class="done">Done when: ${esc(item.doneWhen)}</p>` : "");

const gated = (item) => item.ownerGated.map((gate) => `<p class="gated">Waiting on owner: ${esc(gate)}</p>`).join("");

const AIRY_CSS = `
main{padding:48px 40px 64px}
.head{margin-bottom:24px}
.filters{margin-bottom:56px}
.tier{margin-bottom:56px}
.tier-head{display:flex;align-items:baseline;gap:16px;padding-bottom:16px;margin-bottom:24px;border-bottom:1px solid var(--color-divider)}
.tier-head h2{font-family:var(--font-family-heading),system-ui,sans-serif;font-size:var(--fs-section);font-weight:600;margin:0}
.tier-head .count{font-size:var(--fs-meta);color:var(--color-text-tertiary)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
.card{padding:24px;border-radius:12px;background:var(--color-surface-base);display:flex;flex-direction:column;gap:14px}
.card h3{font-size:var(--fs-title);font-weight:var(--title-weight);margin:0}
.vitals,.refs{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.done{margin:0;color:var(--color-text-secondary)}
.gated{margin:0;color:var(--color-text-warning)}
.foot{display:flex;justify-content:flex-end;margin-top:4px}
@media (max-width:600px){main{padding:28px 16px 48px}.grid{grid-template-columns:1fr;gap:16px}.card{padding:20px}.tier{margin-bottom:40px}.filters{margin-bottom:40px}}
`;

function airyCard(item) {
  return `<article class="card"><h3>${esc(item.title)}</h3><div class="vitals">${vitals(item)}</div>${doneWhen(item)}${gated(item)}
<div class="refs">${refs(item)}</div><div class="foot">${moveSelect(item)}</div></article>`;
}

function airy() {
  const tiers = TIER_ROWS.map((row) => {
    const loops = tierOf(row);
    return `<section class="tier"><div class="tier-head"><h2>${row.label}</h2><span class="meta">${row.hint}</span><span class="count">${loops.length} loops · advisory</span></div>
<div class="grid">${loops.map(airyCard).join("") || '<p class="tertiary">No loops in this tier.</p>'}</div></section>`;
  });
  return page({ title: "Loops · airy", scale: SCALES.roomy, css: AIRY_CSS, view: "loops", body: `<main>${header()}${tiers.join("")}</main>` });
}

const TIER_HUE = { unsorted: "--color-text-tertiary", S: "--color-brand-primary", A: "--color-status-warning", B: "--color-status-info", C: "--color-brand-secondary", parked: "--color-status-success" };

const CARDS_CSS = `
main{padding:40px 32px 56px}
.head{margin-bottom:20px}
.filters{margin-bottom:32px}
.tier{position:relative;margin-bottom:28px;padding:24px 24px 24px 28px;border-radius:14px;background:var(--color-surface-base);box-shadow:var(--lift-1);overflow:hidden}
.tier::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--hue)}
.tier-head{display:flex;align-items:center;gap:16px;margin-bottom:20px}
.mono{display:grid;place-items:center;min-width:44px;height:44px;padding:0 10px;border-radius:10px;background:var(--color-surface-raised);color:var(--hue);font-family:var(--font-family-heading),system-ui,sans-serif;font-size:var(--fs-section);font-weight:700}
.tier-head h2{font-size:var(--fs-title);font-weight:var(--title-weight);margin:0}
.tier-head .meta{display:block}
.count{margin-left:auto;font-family:var(--font-family-heading),system-ui,sans-serif;font-size:var(--fs-section);color:var(--color-text-secondary)}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.card{display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:10px;background:var(--color-surface-raised)}
.top{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.card h3{font-size:var(--fs-title);font-weight:var(--title-weight);margin:0;line-height:1.3}
.done{margin:0;color:var(--color-text-secondary)}
.gated{margin:0;padding:8px 10px;border-radius:6px;background:var(--color-status-warning-subtle);color:var(--color-text-warning);font-size:var(--fs-meta)}
.foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:auto;padding-top:12px;border-top:1px solid var(--color-divider)}
.refs{display:flex;flex-wrap:wrap;gap:6px 10px;min-width:0}
@media (max-width:1100px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:600px){main{padding:24px 12px 40px}.tier{padding:18px 14px 18px 18px}.grid{grid-template-columns:1fr;gap:12px}.foot{flex-direction:column;align-items:stretch}}
`;

function groupedCard(item) {
  return `<article class="card"><div class="top">${vitals(item)}</div><h3>${esc(item.title)}</h3>${doneWhen(item)}${gated(item)}
<div class="foot"><div class="refs">${refs(item)}</div>${moveSelect(item)}</div></article>`;
}

function cards() {
  const tiers = TIER_ROWS.map((row) => {
    const loops = tierOf(row);
    return `<section class="tier" style="--hue:var(${TIER_HUE[row.key]})"><div class="tier-head"><span class="mono">${row.key === "unsorted" ? "?" : row.key === "parked" ? "P" : row.label}</span>
<div><h2>${row.key.length === 1 ? `Tier ${row.label}` : row.label}</h2><span class="meta">Advisory · ${row.hint}</span></div><span class="count">${loops.length}</span></div>
<div class="grid">${loops.map(groupedCard).join("")}</div></section>`;
  });
  return page({ title: "Loops · grouped cards", scale: SCALES.roomy, css: CARDS_CSS, view: "loops", body: `<main>${header()}${tiers.join("")}</main>` });
}

const TABLE_CSS = `
main{padding:32px 32px 48px}
.head{margin-bottom:16px}
.filters{margin-bottom:24px}
.tier{margin-bottom:24px;border:1px solid var(--color-divider);border-radius:10px;overflow:hidden}
.tier-head{display:flex;align-items:baseline;gap:12px;padding:10px 16px;background:var(--color-surface-base)}
.tier-head h2{font-size:var(--fs-meta);font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0}
.tier-head .count{margin-left:auto;font-size:var(--fs-meta);color:var(--color-text-tertiary)}
.row,.cols{display:grid;grid-template-columns:minmax(0,3.2fr) 104px 128px 128px minmax(0,2.4fr) 124px;gap:16px;align-items:center;padding:0 16px}
.cols{height:32px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:var(--color-text-tertiary);border-top:1px solid var(--color-divider)}
.row{min-height:56px;padding-top:8px;padding-bottom:8px;border-top:1px solid var(--color-hairline-subtle)}
.row:nth-child(even){background:var(--color-interactive-hover)}
.row h3{font-size:var(--fs-body);font-weight:var(--title-weight);margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{font-size:var(--fs-meta);color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub.gated{color:var(--color-text-warning)}
.refs{display:flex;flex-wrap:wrap;gap:4px 10px;min-width:0}
.cell-mobile{display:none}
@media (max-width:600px){main{padding:20px 0 40px}.head,.filters{padding:0 16px}.tier{border-radius:0;border-left:0;border-right:0}
.cols{display:none}.row{grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;padding:12px 16px}.row>.wide{display:none}.cell-mobile{display:flex;flex-wrap:wrap;gap:6px 10px;grid-column:1 / -1}}
`;

function tableRow(item) {
  const gates = item.ownerGated.map((gate) => `<div class="sub gated">Waiting on owner: ${esc(gate)}</div>`).join("");
  const sub = `${item.doneWhen ? `<div class="sub">Done when: ${esc(item.doneWhen)}</div>` : ""}${gates}`;
  return `<div class="row"><div><h3>${esc(item.title)}</h3>${sub}</div>
<div class="wide">${statusPill(item.status)}</div><div class="wide">${motionPill(item, isStale(item)) || '<span class="tertiary">—</span>'}</div><div class="wide">${emphasisPill(item) || sourcePill(item) || '<span class="tertiary">—</span>'}</div>
<div class="wide refs">${refs(item)}</div><div>${moveSelect(item)}</div>
<div class="cell-mobile">${statusPill(item.status)}${motionPill(item, isStale(item))}${emphasisPill(item)}${sourcePill(item)}</div><div class="cell-mobile refs">${refs(item)}</div></div>`;
}

function table() {
  const cols = `<div class="cols"><span>Loop</span><span>Status</span><span>Motion</span><span>Emphasis</span><span>Initiative · seat · links</span><span>Move to</span></div>`;
  const tiers = TIER_ROWS.map((row) => {
    const loops = tierOf(row);
    return `<section class="tier"><div class="tier-head"><h2>${row.key.length === 1 ? `Tier ${row.label}` : row.label}</h2><span class="meta">Advisory · ${row.hint}</span><span class="count">${loops.length}</span></div>${cols}${loops.map(tableRow).join("")}</section>`;
  });
  return page({ title: "Loops · compact table", scale: SCALES.compact, css: TABLE_CSS, view: "loops", body: `<main>${header()}${tiers.join("")}</main>` });
}

export const LOOP_DIRECTIONS = { airy, cards, table };

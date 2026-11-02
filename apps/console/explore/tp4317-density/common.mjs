import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(join(dirname(new URL(import.meta.url).pathname), "../../package.json"));

/** The dark theme is react-ui's `:root` block; only that block is inlined, so every colour is a real token. */
function darkTokens() {
  const css = readFileSync(join(dirname(require.resolve("@titan-design/react-ui")), "tokens.css"), "utf8");
  const start = css.indexOf(":root {");
  return css.slice(start, css.indexOf("}", start) + 1);
}

/** Three type scales the round compares; each direction picks one. */
export const SCALES = {
  current: { label: "Current (14 / 16 / 20)", page: 20, section: 20, title: 16, body: 14, meta: 12, lh: 1.43, titleWeight: 500 },
  roomy: { label: "Roomy, ratio 1.25 (15 / 19 / 24 / 30)", page: 30, section: 24, title: 19, body: 15, meta: 13, lh: 1.55, titleWeight: 600 },
  compact: { label: "Compact, ratio 1.2 (14 / 16 / 20 / 24)", page: 24, section: 20, title: 16, body: 14, meta: 12, lh: 1.45, titleWeight: 600 },
};

const scaleVars = (scale) =>
  `--fs-page:${scale.page}px;--fs-section:${scale.section}px;--fs-title:${scale.title}px;--fs-body:${scale.body}px;--fs-meta:${scale.meta}px;--lh:${scale.lh};--title-weight:${scale.titleWeight};`;

const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--color-background-base);color:var(--color-text-primary);font-family:var(--font-family-sans),system-ui,sans-serif;font-size:var(--fs-body);line-height:var(--lh)}
.shell{display:flex;align-items:center;gap:var(--space-inline-lg);padding:12px 24px;background:var(--color-background-frame);border-bottom:1px solid var(--color-divider);font-size:13px;color:var(--color-text-secondary)}
.shell b{color:var(--color-text-primary);font-family:var(--font-family-heading),system-ui,sans-serif}
.shell .on{color:var(--color-text-brand)}
main{max-width:1320px;margin:0 auto}
h1{font-family:var(--font-family-heading),system-ui,sans-serif;font-size:var(--fs-page);font-weight:600;margin:0;letter-spacing:-0.01em}
.lede{color:var(--color-text-secondary);margin:4px 0 0}
.meta{font-size:var(--fs-meta);color:var(--color-text-secondary)}
.tertiary{color:var(--color-text-tertiary)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-meta);line-height:1;padding:4px 8px;border-radius:999px;white-space:nowrap}
.pill.dot::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.t-LOST{color:var(--color-on-status-error-subtle);background:var(--color-status-error-subtle)}
.t-STALLED{color:var(--color-on-status-warning-subtle);background:var(--color-status-warning-subtle)}
.t-ACTIVE{color:var(--color-on-status-info-subtle);background:var(--color-status-info-subtle)}
.t-MISSING{color:var(--color-on-brand-secondary-subtle);background:var(--color-brand-secondary-subtle)}
.t-DONE{color:var(--color-on-status-success-subtle);background:var(--color-status-success-subtle)}
.t-neutral{color:var(--color-text-secondary);background:var(--color-interactive-selected)}
.t-stale{color:var(--color-on-status-error-subtle);background:var(--color-status-error-subtle)}
.ref{font-family:var(--font-family-mono);font-size:var(--fs-meta);color:var(--color-text-link);white-space:nowrap}
.select{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;min-width:120px;height:var(--size-control-sm);padding:0 10px;border:1px solid var(--color-border-input);border-radius:6px;background:var(--color-surface-input);color:var(--color-text-primary);font-size:var(--fs-meta)}
.select::after{content:"▾";color:var(--color-text-tertiary)}
.filters{display:flex;gap:12px;flex-wrap:wrap}
.filters .select{min-width:200px;height:var(--size-control-md);font-size:var(--fs-body)}
.tabs{display:inline-flex;gap:4px;padding:4px;border-radius:999px;background:var(--color-background-subtle)}
.tabs span{padding:6px 14px;border-radius:999px;font-size:var(--fs-meta);color:var(--color-text-secondary)}
.tabs .on{background:var(--color-surface-raised);color:var(--color-text-primary)}
@media (max-width:600px){.shell{padding:10px 16px}.filters .select{min-width:0;flex:1}}
`;

export function page({ title, scale, css, body, view }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${darkTokens()}
:root{${scaleVars(scale)}}
${BASE_CSS}
${css}</style></head>
<body><div class="shell"><b>Console</b><span>Inbox</span><span${view === "loops" ? ' class="on"' : ""}>Loops</span><span${view === "tree" ? ' class="on"' : ""}>Tree</span><span>Rounds</span></div>
${body}
</body></html>
`;
}

export const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const statusPill = (status) => `<span class="pill dot t-${status}">${status}</span>`;

export function motionPill(item, stale) {
  if (item.daysSinceMotion === null) return "";
  return `<span class="pill ${stale ? "t-stale" : "t-neutral"}">${item.daysSinceMotion}d since motion</span>`;
}

export const emphasisPill = (item) => (item.emphasis ? `<span class="pill t-neutral">★ ${item.emphasis.score} · ${item.emphasis.days}d raised</span>` : "");

export const sourcePill = (item) => (item.source !== "ledger" ? `<span class="pill t-neutral">from ${item.source}</span>` : "");

export const moveSelect = (item) => `<span class="select" aria-label="Move ${esc(item.title)}">${item.tier === null ? "Unsorted" : item.tier === "parked" ? "Parked" : `Tier ${item.tier}`}</span>`;

export function refs(item) {
  const seat = item.ownerSeat ? `<span class="ref">@${item.ownerSeat}</span>` : `<span class="meta tertiary">no seat</span>`;
  const links = [...item.tasks, ...item.prsOpen].map((id) => `<span class="ref">${id}</span>`);
  return [`<span class="ref">${item.initiative}</span>`, seat, ...links].join("");
}

export const STATE_LABEL = { done: "Done", "in progress": "In progress", "not started": "Not started", locked: "Locked" };

export const STATE_CSS = `
.s-done{--state:var(--color-status-success);--state-bg:var(--color-status-success-subtle)}
.s-in-progress{--state:var(--color-status-warning);--state-bg:var(--color-status-warning-subtle)}
.s-not-started{--state:var(--color-text-tertiary);--state-bg:transparent}
.s-locked{--state:var(--color-text-disabled);--state-bg:var(--color-interactive-selected)}
`;

export const stateClass = (state) => `s-${state.replace(" ", "-")}`;

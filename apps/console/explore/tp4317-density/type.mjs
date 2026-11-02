import { LOOPS } from "./data.mjs";
import { emphasisPill, esc, motionPill, page, refs, SCALES, statusPill } from "./common.mjs";

const CSS = `
main{padding:40px 32px 56px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px}
.steps{display:flex;flex-direction:column;gap:18px}
.step{display:grid;grid-template-columns:120px minmax(0,1fr);gap:16px;align-items:baseline;padding-bottom:18px;border-bottom:1px solid var(--color-divider)}
.step code{font-family:var(--font-family-mono);font-size:12px;color:var(--color-text-tertiary)}
.page{font-family:var(--font-family-heading),system-ui,sans-serif;font-size:var(--fs-page);font-weight:600}
.section{font-family:var(--font-family-heading),system-ui,sans-serif;font-size:var(--fs-section);font-weight:600}
.title{font-size:var(--fs-title);font-weight:var(--title-weight)}
.sample{display:flex;flex-direction:column;gap:20px}
.card{padding:20px;border-radius:12px;background:var(--color-surface-base);display:flex;flex-direction:column;gap:12px}
.card h3{font-size:var(--fs-title);font-weight:var(--title-weight);margin:0}
.row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.done{margin:0;color:var(--color-text-secondary)}
@media (max-width:600px){main{grid-template-columns:1fr;padding:24px 16px 40px;gap:28px}.step{grid-template-columns:88px minmax(0,1fr)}}
`;

function specimen(key) {
  const scale = SCALES[key];
  const item = LOOPS.find((loop) => loop.id === "l04");
  const steps = [
    ["page", `${scale.page}px`, "Open loops"],
    ["section", `${scale.section}px`, "Tier S · focus now"],
    ["title", `${scale.title}px`, esc(item.title)],
    ["", `${scale.body}px body`, "Tiers are advisory: coordinators weigh them but choose freely."],
    ["meta", `${scale.meta}px meta`, "8d since motion · @harbor-ops · HB-77"],
  ];
  const rows = steps.map(([cls, size, text]) => `<div class="step"><code>${size}</code><span class="${cls}">${text}</span></div>`).join("");
  const card = `<article class="card"><h3>${esc(item.title)}</h3><div class="row">${statusPill(item.status)}${motionPill(item, true)}${emphasisPill(item)}</div>
<p class="done">Done when: ${esc(item.doneWhen)}</p><div class="row">${refs(item)}</div></article>`;
  const body = `<main><section class="steps"><h1>${scale.label}</h1>${rows}</section><section class="sample"><span class="meta">One loop card at this scale, line height ${scale.lh}</span>${card}</section></main>`;
  return page({ title: `Type scale · ${key}`, scale, css: CSS, view: "loops", body });
}

export const TYPE_SCALES = { current: () => specimen("current"), roomy: () => specimen("roomy"), compact: () => specimen("compact") };

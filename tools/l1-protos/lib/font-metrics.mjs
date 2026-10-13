// Measures the faces a theme draws labels in: x-height and average advance as fractions of the
// em, from canvas text metrics in the same headless browser, over the real label strings. The
// layout budgets 0.6 em per character (scene.mjs CHAR), so `worstFill` above 1 means some label
// is wider than its box allows.
/* global document, getComputedStyle */
const PROBE_PX = 100;

// Runs in the browser, so it closes over nothing.
async function measureInPage({ faces, labels, px }) {
  const root = getComputedStyle(document.documentElement);
  const resolve = (f) => f.replace(/var\((--[\w-]+)\)/g, (_, v) => root.getPropertyValue(v).trim());
  const ctx = document.createElement("canvas").getContext("2d");
  const out = [];
  for (const face of faces) {
    const font = `${face.weight} ${px}px ${resolve(face.family)}`;
    await document.fonts.load(font, "xabc0123");
    ctx.font = font;
    const width = (s) => ctx.measureText(s).width / px;
    const chars = labels.reduce((n, l) => n + l.length, 0);
    const total = labels.reduce((n, l) => n + width(l), 0);
    out.push({
      ...face,
      stack: resolve(face.family),
      xHeight: +(ctx.measureText("x").actualBoundingBoxAscent / px).toFixed(4),
      capHeight: +(ctx.measureText("H").actualBoundingBoxAscent / px).toFixed(4),
      avgAdvance: +(total / chars).toFixed(4),
      worstFill: +Math.max(...labels.map((l) => width(l) / (l.length * 0.6))).toFixed(3),
    });
  }
  return out;
}

/** `faces` = [{ name, weight, family }]; `family` may be a CSS custom property such as "var(--font-family-mono)". */
export async function measureFaces(browser, css, faces, labels) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body></body></html>`);
    return await page.evaluate(measureInPage, { faces, labels, px: PROBE_PX });
  } finally {
    await page.close();
  }
}

import type { QaPage } from "./qa-engine.js";

/**
 * A page's virtual clock only moves forward, so every pass over one page must continue from where the last one stopped.
 * The wrapper names the pass and both times when a seek would go back, rather than letting the page's own error surface.
 */
export function forwardOnly(page: QaPage): QaPage {
  let last: { pass: string; t: number } | undefined;
  const seek = (pass: string, t: number): void => {
    if (last !== undefined && t < last.t) {
      throw new Error(`qa ${pass} pass asked the page clock to go back from ${last.t} s (${last.pass} pass) to ${t} s`);
    }
    last = { pass, t };
  };
  return {
    ...page,
    inspectAt: async (t, options) => (seek("inspect", t), page.inspectAt(t, options)),
    probe: async (moments) => (moments.forEach(({ t }) => seek("probe", t)), page.probe(moments)),
  };
}

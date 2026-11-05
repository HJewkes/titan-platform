const ownsText = (el: Element): boolean => [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");

/**
 * Raises every element under `root` that draws its own text below the page's type floor (`--beat-floor`, the size qa's
 * small-text rule enforces) to the floor. Document order, so a child that inherits its size is read after its
 * parent's raise. React rewrites an inline size only when the layer changes it, so the raise holds on every frame.
 */
export function raiseTextToFloor(root: HTMLElement): void {
  const floorPx = Number.parseFloat(getComputedStyle(root).getPropertyValue("--beat-floor"));
  if (!(floorPx > 0)) return;
  for (const el of root.querySelectorAll<HTMLElement | SVGElement>("*")) {
    if (ownsText(el) && Number.parseFloat(getComputedStyle(el).fontSize) < floorPx) el.style.fontSize = `${floorPx}px`;
  }
}

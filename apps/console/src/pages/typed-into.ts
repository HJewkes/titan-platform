/** A key pressed in a field is typing, so no page shortcut may act on it. */
export function typedInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Enter on a focused button or link already activates it, so no page shortcut may take that Enter as well. */
export function onControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('button, a[href], summary, [role="button"], [role="link"]') !== null;
}

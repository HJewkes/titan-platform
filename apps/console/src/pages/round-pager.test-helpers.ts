import { act, fireEvent, screen, waitFor } from "@testing-library/react";

/** jsdom lays nothing out, so it has no scrollIntoView; the pager calls it on every page change. */
export function stubScroll(): void {
  Element.prototype.scrollIntoView = () => undefined;
}

/** The section a paged round shows, or null for a round of one section. */
export const shownSection = (): string | null => document.querySelector("[data-section]")?.getAttribute("data-section") ?? null;

/** Waits for the page to draw section `id` and for its effects, such as the digit keys moving to it, to settle. */
export async function onSection(id: string): Promise<void> {
  await waitFor(() => {
    if (shownSection() !== id) throw new Error(`section ${id} is not shown`);
  });
  await act(async () => undefined);
}

/** Opens a paged round's section from its jump list. */
export async function toSection(id: string): Promise<void> {
  stubScroll();
  fireEvent.click(screen.getByTestId(`section-jump-${id}`));
  await onSection(id);
}

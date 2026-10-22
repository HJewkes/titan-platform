const BUTTON ="button, [role='button']";

// getByRole's hidden check without its style pass: a button inside a closed tab panel or an aria-hidden subtree is not there.
const HIDDEN = "[hidden], [aria-hidden='true']";

const nameOf =(button: Element): string => (button.getAttribute("aria-label") ?? button.textContent).replace(/\s+/g, " ").trim();

/**
 * The one shown button in `container` named `name`, by its aria-label or else its text; it throws when there is
 * none or several, so a mutant that loses or hides a button counts as a kill.
 * getByRole's accessible-name pass styles and names every element on a full round page: hundreds of ms a call alone,
 * ten times that on a loaded runner (TP-3974, TP-3975). Keep getByRole in small component tests, where it is cheap.
 */
export function getButton(name: string | RegExp, container: ParentNode = document.body): HTMLElement {
  const hasName = (button: Element): boolean => (typeof name === "string" ? nameOf(button) === name : name.test(nameOf(button)));
  const matches = (button: Element): boolean => button.closest(HIDDEN) === null && hasName(button);
  const named = [...container.querySelectorAll<HTMLElement>(BUTTON)].filter(matches);
  const outermost = named.filter((button) => !named.some((other) => other !== button && other.contains(button)));
  const [only, ...rest] = outermost;
  if (only === undefined || rest.length > 0) {
    throw new Error(`expected one shown button named "${String(name)}", found ${outermost.length}`);
  }
  return only;
}

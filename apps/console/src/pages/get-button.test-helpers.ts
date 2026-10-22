const BUTTON = "button, [role='button']";

const nameOf = (button: Element): string => (button.getAttribute("aria-label") ?? button.textContent).replace(/\s+/g, " ").trim();

/**
 * The one button in `container` named `name`, by its aria-label or else its text.
 * getByRole's accessible-name pass styles and names every element on a full round page: hundreds of ms a call alone,
 * ten times that on a loaded runner (TP-3974, TP-3975). Keep getByRole in small component tests, where it is cheap.
 */
export function getButton(name: string | RegExp, container: ParentNode = document.body): HTMLElement {
  const matches = (button: Element): boolean => (typeof name === "string" ? nameOf(button) === name : name.test(nameOf(button)));
  const named = [...container.querySelectorAll<HTMLElement>(BUTTON)].filter(matches);
  const outermost = named.filter((button) => !named.some((other) => other !== button && other.contains(button)));
  const [only, ...rest] = outermost;
  if (only === undefined || rest.length > 0) throw new Error(`expected one button named "${String(name)}", found ${outermost.length}`);
  return only;
}

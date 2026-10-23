import { assert } from "vitest";

const ROLES = {
  button: "button, [role='button']",
  tab: "[role='tab']",
  checkbox: "input[type='checkbox'], [role='checkbox']",
  radio: "input[type='radio'], [role='radio']",
} as const;

type FastRole = keyof typeof ROLES;

// getByRole's hidden check without its style pass: a control inside a closed tab panel or an aria-hidden subtree is not there.
const HIDDEN = "[hidden], [aria-hidden='true']";

const nameOf =(element: Element): string => (element.getAttribute("aria-label") ?? element.textContent).replace(/\s+/g, " ").trim();

/** Every shown `role` element in `container` named `name`, by its aria-label or else its text; of nested matches only the outermost. */
export function queryAllByRoleFast(role: FastRole, name: string | RegExp, container: ParentNode = document.body): HTMLElement[] {
  const hasName = (element: Element): boolean => (typeof name === "string" ? nameOf(element) === name : name.test(nameOf(element)));
  const matches = (element: Element): boolean => element.closest(HIDDEN) === null && hasName(element);
  const named = [...container.querySelectorAll<HTMLElement>(ROLES[role])].filter(matches);
  return named.filter((element) => !named.some((other) => other !== element && other.contains(element)));
}

/**
 * The one shown `role` element in `container` named `name`; an AssertionError when there is none or several, so a
 * mutant that loses or hides a control counts as a kill.
 * getByRole's accessible-name pass styles and names every element on a full round page: hundreds of ms a call alone,
 * ten times that on a loaded runner (TP-3974, TP-3975, TP-3981). Keep getByRole in small component tests, where it is cheap.
 */
export function getByRoleFast(role: FastRole, name: string | RegExp, container: ParentNode = document.body): HTMLElement {
  const found = queryAllByRoleFast(role, name, container);
  const [only, ...rest] = found;
  assert(only !== undefined && rest.length === 0, `expected one shown ${role} named "${String(name)}", found ${found.length}`);
  return only;
}

export const getButton = (name: string | RegExp, container?: ParentNode): HTMLElement => getByRoleFast("button", name, container);

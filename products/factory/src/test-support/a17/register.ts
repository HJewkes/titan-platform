import { it } from "vitest";
import { SOURCES_MODES } from "../../github-sources/mode.js";
import { openFeed, type Feed } from "./feed.js";

type Registrar = (name: string, fn: () => void | Promise<void>) => void;

/** Injectable registrar, so the harness's own test can read the titles it would register. */
export function registerA17(title: string, body: (feed: Feed) => void | Promise<void>, register: Registrar): void {
  for (const mode of SOURCES_MODES) register(`A17: ${title} [${mode}]`, () => body(openFeed(mode)));
}

/**
 * Registers `A17: <title> [webhook]` and `A17: <title> [polling]`. The body gets the mode's feed and nothing else that names
 * the mode, so a case cannot quietly skip one.
 */
export function a17Event(title: string, body: (feed: Feed) => void | Promise<void>): void {
  registerA17(title, body, it);
}

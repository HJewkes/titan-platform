import { CHECK_CANDIDATES_HEADING, CHECK_CLASSES, CHECK_ROUTES, MAX_CHECK_CANDIDATES, MAX_CHECK_SKETCH_CHARS } from "../check-candidates.js";

/** One shared vocabulary is what lets Shepherd count a class across PRs; reviewer free text gave a new phrasing almost every time. */
export const CHECK_CANDIDATES_RULE =
  `Optionally, for each finding a deterministic check could have caught, add before the verdict lines a section that starts with a line \`${CHECK_CANDIDATES_HEADING}\`, then one line per finding, at most ${MAX_CHECK_CANDIDATES}: ` +
  `\`- <class key> | <route> | <rule sketch, ${MAX_CHECK_SKETCH_CHARS} characters or fewer>\`. Route is one of ${CHECK_ROUTES.join(", ")}. ` +
  "Take the class key from the list below and the route it is listed under, unless the finding plainly needs another route; coin a short kebab-case key only when none fits. " +
  "Write no line for a one-off bug or a class listed under none. The block never changes your verdict. Write no section when you have none. Class keys by default route:";

/** One line per route that has standard keys; `docs` has none, since the audit gave its findings coined keys. */
function checkClassLines(): string[] {
  return [...CHECK_ROUTES, "none" as const].flatMap((route) => {
    const keys = CHECK_CLASSES.filter((entry) => entry.route === route).map((entry) => `\`${entry.key}\``);
    return keys.length === 0 ? [] : [`- ${route}: ${keys.join(", ")}`];
  });
}

export const checkCandidatesLines = (): string[] => [CHECK_CANDIDATES_RULE, ...checkClassLines()];

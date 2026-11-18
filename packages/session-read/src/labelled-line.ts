const NOT_ALPHANUMERIC = /[^a-z0-9]/g;
const IDENTIFIER_CONTINUES = /^(?:[a-z0-9]|[-_.][a-z0-9])/;
const LIST_NUMBER = /^[0-9]+/;

/** Folds rather than matching a list of decorations, so a decoration no one listed still reads as labelled: NFKC, lower case, every non-alphanumeric and any leading list number gone. */
export function foldLabelledLine(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().replace(NOT_ALPHANUMERIC, "").replace(LIST_NUMBER, "");
}

/** The raw span that folds to a leading `foldedLabel`: any non-letters, then the label's characters with no alphanumeric between. */
const labelSpan = (foldedLabel: string): RegExp => new RegExp(`^[^a-z]*${[...foldedLabel].join("[^a-z0-9]*")}`);

/**
 * The folded text after `label` when `raw` is a line labelled `label` through any decoration (a bullet, bold, a quote
 * marker, any case, a full-width colon), or undefined for an unlabelled line. A label glued to an identifier character
 * (`ci-policy-changes.ts`, `ciPolicyAt`) is a code name, not the label (TP-3237), unless its rest starts `strictValue`:
 * the strict reading is never dropped, however it is spelt. Every reviewer-verdict label reads through this one fold.
 */
export function labelledLineRest(raw: string, label: string, strictValue?: string): string | undefined {
  const foldedLabel = foldLabelledLine(label);
  const folded = foldLabelledLine(raw);
  if (!folded.startsWith(foldedLabel)) return undefined;
  const rest = folded.slice(foldedLabel.length);
  if (strictValue !== undefined && rest.startsWith(strictValue)) return rest;
  const span = labelSpan(foldedLabel).exec(raw.normalize("NFKC").toLowerCase());
  const after = span ? span.input.slice(span[0].length) : "";
  return IDENTIFIER_CONTINUES.test(after) ? undefined : rest;
}

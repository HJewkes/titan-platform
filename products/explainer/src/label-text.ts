/** Drops `repo@sha:` and directory prefixes, so `tp@a1b8cdeb:products/x/wake.ts:35` reads `wake.ts:35`. */
export const shortRef = (ref: string): string => ref.replace(/^[\w-]+@[0-9a-f]+:/, "").replace(/(?:[\w.~-]+\/)+/g, "");

// drawtext reads quotes, colons, backslashes and percents as syntax; beat ids never need them.
export const drawable = (label: string): string => label.replace(/[^A-Za-z0-9 ._/-]/g, "_");

// Fails the build when a prerendered page is not a finished document: a placeholder the prerender should have
// replaced, or no react-native-web stylesheet, which leaves every `r-` class unstyled with JS off.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const PLACEHOLDERS = ["<!--app-head-->", "<!--app-html-->", "<!--app-route-->"];
const RNW_STYLE = '<style id="react-native-stylesheet">';

/** @param {string} dir @returns {string[]} */
function htmlFiles(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".html"))
    .sort();
}

/** @param {string} name @param {string} text @returns {string[]} */
function pageProblems(name, text) {
  const problems = PLACEHOLDERS.filter((p) => text.includes(p)).map((p) => `${name} still holds ${p}`);
  if (!text.includes(RNW_STYLE)) problems.push(`${name} has no react-native-web stylesheet`);
  return problems;
}

/**
 * Every problem in a built site, as `<page> <reason>` lines; empty when the site is whole.
 * @param {string} siteDir
 * @returns {string[]}
 */
export function checkDist(siteDir) {
  const problems = existsSync(join(siteDir, "index.html")) ? [] : ["index.html is missing"];
  for (const file of htmlFiles(siteDir)) {
    problems.push(...pageProblems(file.split(sep).join("/"), readFileSync(join(siteDir, file), "utf8")));
  }
  return problems;
}

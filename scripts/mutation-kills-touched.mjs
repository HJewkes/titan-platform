// Which tests in one test file a diff touches, by vitest full name (TP-3975). A test is touched when a changed line
// sits in its body, or its body names a helper a changed line sits in, or a helper that names one, and so on. A
// sidecar whose kills hold none of them proves something other than the change. Deleted lines touch nothing: a
// deletion that matters leaves a changed line behind where the code went.

import ts from "typescript";

const TEST_CALLS = new Set(["it", "test"]);
const SUITE_CALLS = new Set(["describe", "suite"]);

/** The 1-based new-side line numbers a `git diff -U0` adds or rewrites. */
export function changedLines(diff) {
  const lines = new Set();
  for (const [, start, count] of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const first = Number(start);
    for (let line = first; line < first + Number(count ?? 1); line += 1) lines.add(line);
  }
  return lines;
}

function callRoot(call) {
  let callee = call.expression;
  while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
  return ts.isIdentifier(callee) ? callee.text : null;
}

function titleOf(node) {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function declName(node) {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  return null;
}

/** Each test as `{ name, first, last, text }` and each helper outside a test as `{ name, first, last, text }`. */
export function unitsOf(source, path = "file.tsx") {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const span = (node) => ({ first: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, last: file.getLineAndCharacterOfPosition(node.getEnd()).line + 1, text: node.getText() });
  const tests = [];
  const helpers = [];
  const visit = (node, suites) => {
    const root = ts.isCallExpression(node) ? callRoot(node) : null;
    const title = root === null ? null : titleOf(node.arguments[0]);
    if (title !== null && TEST_CALLS.has(root)) return void tests.push({ name: [...suites, title].join(" "), ...span(node) });
    const name = declName(node);
    if (name !== null) helpers.push({ name, ...span(node) });
    const inner = title !== null && SUITE_CALLS.has(root) ? [...suites, title] : suites;
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(file, []);
  return { tests, helpers };
}

const holdsLine = (unit, lines) => [...lines].some((line) => line >= unit.first && line <= unit.last);
const names = (unit, helper) => new RegExp(`\\b${helper.name}\\b`).test(unit.text);

/** The full names of the tests `lines` touch in `source`, directly or through the helpers they call. */
export function touchedTests(source, lines) {
  const { tests, helpers } = unitsOf(source);
  const touched = new Set(helpers.filter((helper) => holdsLine(helper, lines)));
  for (let grew = true; grew; ) {
    const more = helpers.filter((helper) => !touched.has(helper) && [...touched].some((used) => helper !== used && names(helper, used)));
    for (const helper of more) touched.add(helper);
    grew = more.length > 0;
  }
  const reached = (test) => holdsLine(test, lines) || [...touched].some((helper) => names(test, helper));
  return new Set(tests.filter(reached).map((test) => test.name));
}

/** A problem line when `touched` is non-empty and no mutation in `sidecar` kills any of it; else null. */
export function missedChange(sidecar, touched) {
  if (touched.size === 0) return null;
  const kills = (sidecar.mutations ?? []).flatMap((mutation) => mutation.kills ?? []);
  return kills.some((kill) => touched.has(kill)) ? null : `no kill names a test the diff touches (${[...touched].map((name) => JSON.stringify(name)).join(", ")})`;
}

// Reads TypeScript source for dead-code-check.mjs: code-graph has no edge for a namespace import's members
// or for a use inside the declaring file, so those are found in the source. The TypeScript parser decides what is
// a comment, string, template, regex, JSX text or a property key, so no lexing rule here guesses at a `/`.
import ts from "typescript";

const SCRIPT_KINDS = { ".ts": ts.ScriptKind.TS, ".mts": ts.ScriptKind.TS, ".cts": ts.ScriptKind.TS, ".js": ts.ScriptKind.JS, ".mjs": ts.ScriptKind.JS };

// Without a file name the source is read as TSX, the superset that also parses JSX text.
function parse(src, fileName) {
  const kind = SCRIPT_KINDS[fileName.slice(fileName.lastIndexOf("."))] ?? ts.ScriptKind.TSX;
  return ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, false, kind);
}

const isJsDoc = (node) => node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

/** Calls visit for every node and token of the tree, JSDoc excluded since the comment scan already blanks it. */
function walk(node, sf, visit) {
  visit(node);
  for (const child of node.getChildren(sf)) if (!isJsDoc(child)) walk(child, sf, visit);
}

const K = ts.SyntaxKind;
const TEMPLATE_INNER = {
  [K.NoSubstitutionTemplateLiteral]: [1, 1],
  [K.TemplateHead]: [1, 2],
  [K.TemplateMiddle]: [1, 2],
  [K.TemplateTail]: [1, 1],
  [K.StringLiteral]: [1, 1],
};
const MEMBER_KINDS = new Set([K.PropertyAssignment, K.PropertySignature, K.MethodSignature]);

/** The [from, to) spans of text that is not code, for one node. */
function blankedSpans(node, sf, text) {
  const start = node.getStart(sf);
  const inner = TEMPLATE_INNER[node.kind];
  const comments = [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.pos) ?? [])];
  const spans = comments.map((c) => [c.pos, c.end]);
  if (inner) spans.push([start + inner[0], node.end - inner[1]]);
  else if (node.kind === K.RegularExpressionLiteral) spans.push([start + 1, text.lastIndexOf("/", node.end - 1)]);
  else if (node.kind === K.JsxText) spans.push([node.pos, node.end]);
  else if (MEMBER_KINDS.has(node.kind) && ts.isIdentifier(node.name)) spans.push([node.name.getStart(sf), node.name.end]);
  return spans;
}

/** The masked source plus the specifiers imported whole: `import * as ns from "x"` and `import("x")`, never inside a comment or string. */
export function analyzeSource(src, fileName = "source.tsx") {
  const sf = parse(src, fileName);
  const out = src.split("");
  const namespace = [];
  const dynamic = [];
  walk(sf, sf, (node) => {
    for (const [from, to] of blankedSpans(node, sf, src)) for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
    const namespaceSpecifier = namespaceImportSpecifier(node);
    if (namespaceSpecifier !== undefined) namespace.push(namespaceSpecifier);
    const dynamicSpecifier = dynamicImportSpecifier(node);
    if (dynamicSpecifier !== undefined) dynamic.push(dynamicSpecifier);
  });
  return { masked: out.join(""), namespace, dynamic };
}

function namespaceImportSpecifier(node) {
  const bindings = node.kind === K.ImportDeclaration ? node.importClause?.namedBindings : undefined;
  return bindings && ts.isNamespaceImport(bindings) && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

/** `import("x")` or ``import(`x`)``; a template with a substitution has no fixed specifier. */
function dynamicImportSpecifier(node) {
  if (node.kind !== K.CallExpression || node.expression.kind !== K.ImportKeyword) return undefined;
  const [arg] = node.arguments;
  return arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
}

/** The source with comments and string, template, regex, JSX text and property-key text blanked to spaces; offsets still index the original. */
export function maskSource(src, fileName = "source.tsx") {
  return analyzeSource(src, fileName).masked;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * How often name appears as an identifier in the masked source, its declaration included. Property names after a
 * single dot, object keys, interface members and names inside an `export { … }` list are not uses.
 */
export function identifierMentions(masked, name) {
  const code = masked.replace(/export\s+(?:type\s+)?\{[^}]*\}/g, "");
  const pattern = new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.)${escapeRegExp(name)}(?![\\w$])`, "g");
  return [...code.matchAll(pattern)].length;
}

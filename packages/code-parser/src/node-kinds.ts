/**
 * The tree-sitter node types treated as functions and classes, kept in one place so code-graph's
 * symbols, scope paths, metrics, dead code and growth risk, and style-analyzer, agree on what a declaration is.
 * Callers that need a narrower or wider notion compose these sets instead of restating them.
 */

/** The plain TypeScript function declaration, the only function form whose dead-code position is exempt by hoisting. */
export const TS_FUNCTION_DECLARATION = "function_declaration";

/** A class or object-literal method. */
export const TS_METHOD_DEFINITION = "method_definition";

/** Function declarations that carry their own name: plain, generator and method. */
export const TS_FUNCTION_DECL_TYPES: ReadonlySet<string> = new Set([
  TS_FUNCTION_DECLARATION,
  "generator_function_declaration",
  TS_METHOD_DEFINITION,
]);

/** Function values that take the name of the `const`/`let` they are bound to. */
export const TS_BOUND_FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
]);

/** Every TypeScript function form, named or bound. */
export const TS_FUNCTION_TYPES: ReadonlySet<string> = new Set([
  ...TS_FUNCTION_DECL_TYPES,
  ...TS_BOUND_FUNCTION_TYPES,
]);

/** Class declarations that carry their own name: plain and abstract. */
const TS_CLASS_DECL_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
]);

/** Node types the TypeScript grammar emits for a class: declarations, abstract declarations and class expressions. */
export const TS_CLASS_TYPES: ReadonlySet<string> = new Set([...TS_CLASS_DECL_TYPES, "class"]);

/** Named TypeScript declarations: functions, generators, methods and classes. */
export const TS_DECL_TYPES: ReadonlySet<string> = new Set([
  ...TS_FUNCTION_DECL_TYPES,
  ...TS_CLASS_DECL_TYPES,
]);

/** Python functions and methods; lambdas are excluded because they carry no name. */
export const PY_FUNCTION_TYPES: ReadonlySet<string> = new Set(["function_definition"]);

/** Named Python declarations: functions and classes. */
export const PY_DECL_TYPES: ReadonlySet<string> = new Set([...PY_FUNCTION_TYPES, "class_definition"]);

/** Named function declarations in either language. */
export const NAMED_FUNCTION_TYPES: ReadonlySet<string> = new Set([
  ...TS_FUNCTION_DECL_TYPES,
  ...PY_FUNCTION_TYPES,
]);

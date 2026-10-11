/**
 * The tree-sitter node types treated as functions and classes, kept in one place so code-graph's
 * symbols, scope paths, metrics, dead code and growth risk, and style-analyzer, agree on what a declaration is.
 * Callers that need a narrower or wider notion compose these sets instead of restating them.
 */
/** The plain TypeScript function declaration, the only function form whose dead-code position is exempt by hoisting. */
declare const TS_FUNCTION_DECLARATION = "function_declaration";
/** A class or object-literal method. */
declare const TS_METHOD_DEFINITION = "method_definition";
/** Function declarations that carry their own name: plain, generator and method. */
declare const TS_FUNCTION_DECL_TYPES: ReadonlySet<string>;
/** Function values that take the name of the `const`/`let` they are bound to. */
declare const TS_BOUND_FUNCTION_TYPES: ReadonlySet<string>;
/** Every TypeScript function form, named or bound. */
declare const TS_FUNCTION_TYPES: ReadonlySet<string>;
/** Node types the TypeScript grammar emits for a class: declarations, abstract declarations and class expressions. */
declare const TS_CLASS_TYPES: ReadonlySet<string>;
/** Named TypeScript declarations: functions, generators, methods and classes. */
declare const TS_DECL_TYPES: ReadonlySet<string>;
/** Python functions and methods; lambdas are excluded because they carry no name. */
declare const PY_FUNCTION_TYPES: ReadonlySet<string>;
/** Named Python declarations: functions and classes. */
declare const PY_DECL_TYPES: ReadonlySet<string>;
/** Named function declarations in either language. */
declare const NAMED_FUNCTION_TYPES: ReadonlySet<string>;

export { NAMED_FUNCTION_TYPES, PY_DECL_TYPES, PY_FUNCTION_TYPES, TS_BOUND_FUNCTION_TYPES, TS_CLASS_TYPES, TS_DECL_TYPES, TS_FUNCTION_DECLARATION, TS_FUNCTION_DECL_TYPES, TS_FUNCTION_TYPES, TS_METHOD_DEFINITION };

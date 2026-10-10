import type { Rule } from "eslint";
import type { CallExpression, Node } from "estree";

const DEFAULT_INTERNAL_PREFIXES = ["@titan-design/"];
const TEST_APIS = new Set(["vi", "jest"]);
const MOCK_METHODS = new Set(["mock", "doMock", "unstable_mockModule"]);

function memberName({ computed, property }: { computed: boolean; property: Node }): string | null {
  if (!computed && property.type === "Identifier") return property.name;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : null;
}

/** `vi.mock`, `jest.doMock` and the like, as `vi.mock`; null for any other call. */
function moduleMockCall({ callee }: CallExpression): string | null {
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return null;
  const api = callee.object.name;
  const method = memberName(callee);
  return TEST_APIS.has(api) && method !== null && MOCK_METHODS.has(method) ? `${api}.${method}` : null;
}

// `vi.mock(import("./x"))` is vitest's typed form of `vi.mock("./x")`.
function staticSpecifier(argument: Node | undefined): string | null {
  if (argument?.type === "ImportExpression") return staticSpecifier(argument.source);
  if (argument?.type === "Literal" && typeof argument.value === "string") return argument.value;
  if (argument?.type !== "TemplateLiteral" || argument.expressions.length > 0) return null;
  return argument.quasis[0]?.value.cooked ?? null;
}

/** Relative, absolute and `#` subpath specifiers are this repo's own code, as is any configured package prefix. */
function isInternalSpecifier(specifier: string, internalPrefixes: readonly string[]): boolean {
  return /^[./#]/.test(specifier) || internalPrefixes.some((prefix) => specifier.startsWith(prefix));
}

export const noInternalModuleMock: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow mocking this repo's own modules; mock only external dependencies" },
    schema: [
      {
        type: "object",
        properties: { internalPrefixes: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      internalMock:
        '`{{call}}("{{specifier}}")` mocks this repo\'s own code, so the test stops exercising it. Mock only external dependencies (node: builtins, third-party packages): pass the dependency in as a parameter, or use the package\'s own fake.',
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { internalPrefixes?: string[] };
    const internalPrefixes = options.internalPrefixes ?? DEFAULT_INTERNAL_PREFIXES;
    return {
      CallExpression(node) {
        const call = moduleMockCall(node);
        const specifier = call === null ? null : staticSpecifier(node.arguments[0]);
        if (specifier === null || !isInternalSpecifier(specifier, internalPrefixes)) return;
        context.report({ node, messageId: "internalMock", data: { call: call ?? "", specifier } });
      },
    };
  },
};

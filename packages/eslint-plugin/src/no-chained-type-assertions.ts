import type { Rule } from "eslint";
import type { SourceLocation } from "estree";

// typescript-estree nodes are not in ESTree's types, so the rule reads the few fields it needs structurally.
type Annotation = { type: string; typeName?: { type: string; name?: string } };
type AssertionLike = {
  type: string;
  expression?: AssertionLike;
  typeAnnotation?: Annotation;
  parent?: AssertionLike;
  loc?: SourceLocation | null;
};

const ASSERTIONS = new Set(["TSAsExpression", "TSTypeAssertion"]);

function isAssertion(node: AssertionLike | undefined): node is AssertionLike {
  return node !== undefined && ASSERTIONS.has(node.type);
}

function isConstAssertion({ typeAnnotation }: AssertionLike): boolean {
  return typeAnnotation?.type === "TSTypeReference" && typeAnnotation.typeName?.name === "const";
}

function assertionChain(outermost: AssertionLike): AssertionLike[] {
  const chain: AssertionLike[] = [];
  for (let node: AssertionLike | undefined = outermost; isAssertion(node); node = node.expression) chain.push(node);
  return chain;
}

export const noChainedTypeAssertions: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow a type assertion applied to another type assertion, such as `x as unknown as T`" },
    schema: [],
    messages: {
      chained:
        "Chained type assertion: `as unknown as T` hides a type error from the checker. Parse the value (zod or a type guard), give it its real type, or in a test build the fake with `partialFake<T>()` from @titan-design/test-kit.",
    },
  },
  create(context) {
    const check = (node: AssertionLike): void => {
      if (isAssertion(node.parent)) return;
      const chain = assertionChain(node);
      if (chain.length < 2 || chain.every(isConstAssertion) || !node.loc) return;
      context.report({ loc: node.loc, messageId: "chained" });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

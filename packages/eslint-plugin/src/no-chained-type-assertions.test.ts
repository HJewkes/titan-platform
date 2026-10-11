import { noChainedTypeAssertions } from "./no-chained-type-assertions.js";
import { tsRuleTester } from "./test-fixtures.js";

const message =
  "Chained type assertion: `as unknown as T` hides a type error from the checker. Parse the value (zod or a type guard), give it its real type, or in a test build the fake with `partialFake<T>()` from @titan-design/test-kit.";

tsRuleTester.run("no-chained-type-assertions", noChainedTypeAssertions, {
  valid: [
    { name: "a single as assertion", code: "const a = value as Thing;" },
    { name: "a single angle-bracket assertion", code: "const a = <Thing>value;" },
    { name: "a chain of as const assertions", code: "const a = (value as const) as const;" },
    { name: "two separate assertions in one expression", code: "const a = [x as A, y as B];" },
    { name: "an assertion inside a call argument of an assertion", code: "const a = f(x as A) as B;" },
    { name: "satisfies after an assertion is not an assertion", code: "const a = (x as A) satisfies B;" },
    { name: "a non-null assertion before as", code: "const a = value! as Thing;" },
  ],
  invalid: [
    { name: "as unknown as T", code: "const a = value as unknown as Thing;", errors: [{ message }] },
    { name: "as any as T", code: "const a = value as any as Thing;", errors: [{ message }] },
    { name: "a parenthesized inner assertion", code: "const a = (value as unknown) as Thing;", errors: [{ message }] },
    { name: "angle brackets around as", code: "const a = <Thing>(value as unknown);", errors: [{ message }] },
    { name: "nested angle brackets", code: "const a = <Thing>(<unknown>value);", errors: [{ message }] },
    { name: "as const followed by a real assertion", code: "const a = (value as const) as Thing;", errors: [{ message }] },
    {
      name: "a triple chain reports once, at the outermost assertion",
      code: "const a = value as unknown as A as B;",
      errors: [{ message, column: 11 }],
    },
    {
      name: "each chain is reported",
      code: "const a = x as unknown as A;\nconst b = y as unknown as B;",
      errors: [{ message, line: 1 }, { message, line: 2 }],
    },
  ],
});

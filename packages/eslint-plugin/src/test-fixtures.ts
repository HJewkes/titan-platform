import tseslint from "typescript-eslint";
import { RuleTester } from "eslint";
import { describe, it } from "vitest";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

export const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } });

export const tsRuleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

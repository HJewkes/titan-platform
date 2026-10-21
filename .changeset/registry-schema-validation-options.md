---
"@titan-design/registry": minor
---

Add optional MCP schema input/output and override controls plus product-specific invalid-argument formatting. Existing projection and validation defaults remain unchanged.

Expose CLI value placeholders, variadic array positionals and explicit option defaults so consumers can preserve their existing help and argv contracts.

Breaking for array-typed positionals: they now render as variadic (`<name...>`, `[name...]`) and take every remaining argument, where before they took one value wrapped into an array. An array positional must be the last positional, or Commander throws at setup. An omitted variadic is left out of the args instead of arriving as `[]`, so zod defaults apply and the CLI matches MCP and HTTP.

import js from "@eslint/js";
import { recommended as titan } from "@titan-design/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

const EVENTS_API_MESSAGE =
  "The GitHub Activity Events API is never an event source: it lags 30 s to 6 h. Use a webhook, or read GraphQL timelineItems.";
// The path form is repos|networks/<a>/<b>, orgs|users/<a>, then events (users also received_events), or a bare /events.
const EVENTS_PATH =
  "(^|[\\s'\"`\\x2f])((repos|networks)\\x2f[^\\x2f\\s]+\\x2f[^\\x2f\\s]+\\x2fevents|orgs\\x2f[^\\x2f\\s]+\\x2fevents|users\\x2f[^\\x2f\\s]+\\x2f(received_)?events|^\\x2fevents)([?\\s'\"`]|$)";
// A template splits at each ${}, so a quasi can hold only the tail such as "/events"; the head is not recoverable.
// The tail must end the quasi, so prose such as "the /events hub" and "hold events" stays legal.
const EVENTS_TEMPLATE_TAIL = "(^|[^\\s])\\x2f(received_)?events([?]|$)";
const EVENTS_API_SELECTORS = [
  { selector: `Literal[value=/${EVENTS_PATH}/]`, message: EVENTS_API_MESSAGE },
  { selector: `TemplateElement[value.raw=/${EVENTS_TEMPLATE_TAIL}/]`, message: EVENTS_API_MESSAGE },
  { selector: "MemberExpression[property.name=/^list.*Events/][object.property.name='activity']", message: EVENTS_API_MESSAGE },
  { selector: "MemberExpression[property.name=/^list.*Events/][object.name='activity']", message: EVENTS_API_MESSAGE },
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".codewatch/**",
      ".codewatch-tool/**",
      // Holds deliberate violations; scripts/eslint-recommended.test.mjs lints it from its own directory.
      "scripts/fixtures/eslint-recommended/**",
      // Holds deliberate Events API uses; scripts/eslint-recommended.test.mjs lints it from its own directory.
      "scripts/fixtures/events-api/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  titan,
  // A describe or it callback holds a whole suite, so the function limit applies to source only.
  { files: ["**/*.test.{ts,tsx,mts,mjs,js}"], rules: { "titan/max-function-lines": "off" } },
  // Test tables and fixtures hold long data rows by design, so the cap targets packed logic in source.
  {
    files: ["packages/*/src/**", "products/*/src/**"],
    ignores: ["**/*.test.*", "**/fixtures/**", "**/__fixtures__/**", "**/test-support/**"],
    rules: { "titan/max-line-length": ["error", { max: 200 }] },
  },
  // The Activity Events API lags 30 s to 6 h, so it is never an event source (TP-3095 D-M1a-02). GraphQL timelineItems is not it.
  {
    files: ["products/factory/**", "packages/github/**"],
    rules: { "no-restricted-syntax": ["error", ...EVENTS_API_SELECTORS] },
  },
  { languageOptions: { globals: globals.node } },
  { files: ["apps/*/src/**"], languageOptions: { globals: globals.browser } },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);

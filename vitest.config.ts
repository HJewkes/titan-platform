import { defineConfig } from "vitest/config";

export default defineConfig({
  // Apps render @titan-design/react-ui, which is written against React Native primitives; no package imports react-native.
  resolve: { alias: { "react-native": "react-native-web" } },
  test: {
    // Inlined so the alias above applies; left external, Node would load react-native's Flow source.
    server: { deps: { inline: [/@titan-design\/react-ui/] } },
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "products/*/src/**/*.test.{ts,tsx}",
      "apps/*/src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}", "products/*/src/**/*.{ts,tsx}", "apps/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/index.ts"],
    },
  },
});

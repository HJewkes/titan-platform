import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // The site is served from the GitHub Pages project path.
  base: "/titan-platform/",
  plugins: [react()],
  // react-ui is written against React Native primitives; its web dist expects this alias (titan-design docs/WEB_SETUP.md).
  resolve: { alias: { "react-native": "react-native-web" } },
  // The SSR bundle inlines react-ui so the alias reaches its bare `react-native` imports.
  ssr: { noExternal: ["@titan-design/react-ui"] },
});

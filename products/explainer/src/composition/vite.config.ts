import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const presetPath = require.resolve("@titan-design/react-ui/tailwind.config.js");
// react-ui's package.json is not exported, so its dist is located through an exported file.
const reactUiDist = join(dirname(presetPath), "dist");

const outDir = join(root, "../../dist/composition");

export default defineConfig({
  root,
  // Relative asset URLs, so the built page serves from any path.
  base: "./",
  plugins: [react()],
  // react-ui is written against React Native primitives; on web it renders through react-native-web (TD-845).
  resolve: { alias: { "react-native": "react-native-web" } },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          presets: [require(presetPath)],
          content: [join(root, "*.html"), join(root, "**/*.tsx"), `${reactUiDist}/**/*.{js,mjs}`],
          darkMode: "class",
        }),
        autoprefixer(),
      ],
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    // One page loaded from loopback for capture, never over a network, so one large chunk costs nothing.
    chunkSizeWarningLimit: 1024,
    rollupOptions: { input: { index: join(root, "index.html"), baked: join(root, "baked.html") } },
  },
});

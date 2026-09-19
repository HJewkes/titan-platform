import react from "@vitejs/plugin-react";
import { titanApp } from "@titan-design/react-app/vite";
import { defineConfig } from "vite";

const daemonPort = process.env.CODE_REPORT_PORT ?? "7433";

export default defineConfig({
  plugins: [react(), ...titanApp({ daemonUrl: `http://127.0.0.1:${daemonPort}` })],
  // react-ui is written against React Native primitives; its web dist expects this alias (titan-design docs/WEB_SETUP.md).
  resolve: { alias: { "react-native": "react-native-web" } },
  // Keeps any stray absolute asset URL relative, so the single file also opens from disk.
  base: "./",
});

import react from "@vitejs/plugin-react";
import { daemonProxy, titanApp } from "@titan-design/react-app/vite";
import { defineConfig } from "vite";

const daemonPort = process.env.TITAN_CONSOLE_PORT ?? "7500";
const daemonUrl = `http://127.0.0.1:${daemonPort}`;
// titanApp forwards only the daemon's built-in routes; the theater's media routes need the same forwarding.
const mediaProxy = { "^/media/": Object.values(daemonProxy(daemonUrl))[0] ?? daemonUrl };

export default defineConfig({
  plugins: [react(), ...titanApp({ daemonUrl })],
  server: { proxy: mediaProxy },
  preview: { proxy: mediaProxy },
  // react-ui is written against React Native primitives; its web dist expects this alias (titan-design docs/WEB_SETUP.md).
  resolve: { alias: { "react-native": "react-native-web" } },
  // Keeps any stray absolute asset URL relative, so the single file also opens from disk.
  base: "./",
});

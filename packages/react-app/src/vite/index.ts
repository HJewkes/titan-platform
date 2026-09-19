import type { Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { daemonProxy } from "./dev-proxy.js";

export type { ForwardedHeaders } from "./dev-proxy.js";
export { PROXIED_ROUTES, daemonHeaders, daemonProxy, isLoopbackHost } from "./dev-proxy.js";

/** The daemon package's default port. */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7400";

export interface TitanAppOptions {
  /** Daemon the dev and preview servers forward `/rpc/*`, `/events`, `/health`, and `/version` to. */
  daemonUrl?: string;
  /** Inline every script and stylesheet into `index.html`, so the build opens from disk. Defaults to true. */
  singleFile?: boolean;
}

/** Vite plugins for a daemon-backed app. Add a framework plugin such as `@vitejs/plugin-react` beside them. */
export function titanApp(options: TitanAppOptions = {}): Plugin[] {
  const proxy = daemonProxy(options.daemonUrl ?? DEFAULT_DAEMON_URL);
  const preset: Plugin = {
    name: "titan-app",
    config: () => ({ server: { proxy }, preview: { proxy } }),
  };
  return options.singleFile === false ? [preset] : [preset, viteSingleFile() as Plugin];
}

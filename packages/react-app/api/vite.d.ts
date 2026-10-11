import { ProxyOptions, Plugin } from 'vite';

/**
 * Anchored on purpose: a bare "/rpc" key is a prefix match that also captures a source
 * module such as "/rpc.ts", which then fails to load and blanks the page.
 */
declare const PROXIED_ROUTES: string[];
interface ForwardedHeaders {
    host?: string;
    origin?: string;
}
/**
 * The Host and Origin the daemon should see for one dev-server request. A same-origin
 * request to a loopback dev server becomes a same-origin request to the daemon; anything
 * else is forwarded untouched, so the daemon's own guards refuse it exactly as they would
 * refuse it directly. Content-Type is never touched.
 */
declare function daemonHeaders(incoming: ForwardedHeaders, daemon: URL): ForwardedHeaders;
declare function isLoopbackHost(host: string): boolean;
/** Vite `server.proxy` entries that forward the daemon's routes to `daemonUrl`. */
declare function daemonProxy(daemonUrl: string): Record<string, ProxyOptions>;

/** The daemon package's default port. */
declare const DEFAULT_DAEMON_URL = "http://127.0.0.1:7400";
interface TitanAppOptions {
    /** Daemon the dev and preview servers forward `/rpc/*`, `/events`, `/health`, and `/version` to. */
    daemonUrl?: string;
    /** Inline every script and stylesheet into `index.html`, so the build opens from disk. Defaults to true. */
    singleFile?: boolean;
}
/** Vite plugins for a daemon-backed app. Add a framework plugin such as `@vitejs/plugin-react` beside them. */
declare function titanApp(options?: TitanAppOptions): Plugin[];

export { DEFAULT_DAEMON_URL, type ForwardedHeaders, PROXIED_ROUTES, type TitanAppOptions, daemonHeaders, daemonProxy, isLoopbackHost, titanApp };

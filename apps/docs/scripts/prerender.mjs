// Writes one static HTML document per route from the client build's index.html and the SSR bundle's render().
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The route's page: the template with its head tags, markup and route script filled in. A replacer function keeps a
 * `$` in the markup literal.
 * @param {string} template
 * @param {string} route
 * @param {{ html: string, head: string }} rendered
 */
export function fillTemplate(template, route, rendered) {
  // Escaped so a route can never close the script element it sits in.
  const routeJson = JSON.stringify(route).replaceAll("<", "\\u003c");
  return template
    .replace("<!--app-head-->", () => rendered.head)
    .replace("<!--app-html-->", () => rendered.html)
    .replace("<!--app-route-->", () => `<script>window.__ROUTE__ = ${routeJson};</script>`);
}

/**
 * Renders every route in this process, so react-native-web's sheet and Vite's NODE_ENV are shared across pages.
 * @param {string} distDir holds client/ and server/ from the two vite builds; site/ is written beside them.
 * @returns {Promise<string[]>} the routes written
 */
export async function prerender(distDir) {
  const server = await import(pathToFileURL(join(distDir, "server", "entry-server.js")).href);
  const template = readFileSync(join(distDir, "client", "index.html"), "utf8");
  const site = join(distDir, "site");
  cpSync(join(distDir, "client", "assets"), join(site, "assets"), { recursive: true });
  for (const route of server.ROUTES) {
    const dir = join(site, route);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), fillTemplate(template, route, server.render(route)));
  }
  return [...server.ROUTES];
}

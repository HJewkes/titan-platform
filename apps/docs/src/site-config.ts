/** The path GitHub Pages serves the site under; vite.config.ts sets the same `base`. */
const BASE = "/titan-platform/";

interface NavLink {
  text: string;
  link: string;
}

// Ported from site/.vitepress/config.mts themeConfig.nav, the live site's top nav.
export const NAV: readonly NavLink[] = [
  { text: "Home", link: "/" },
  { text: "Get started", link: "/getting-started" },
  { text: "Capabilities", link: "/guides/capabilities" },
  { text: "Packages", link: "/reference/" },
  { text: "Guides", link: "/guides/" },
];

/** A site-root path as the browser must request it. */
export function withBase(path: string): string {
  return `${BASE}${path.replace(/^\//, "")}`;
}

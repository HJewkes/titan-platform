import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
// Emitted by `pnpm docs:reference` from the workspace and the DAG in
// .codewatch/check.json, so a new package never needs a hand edit here.
import referenceSidebar from "./reference-sidebar.json";

// GitHub Pages serves this as a project site under /titan-platform/, not the
// repo root, so every asset and link needs that prefix baked in.
export default withMermaid(
  defineConfig({
    title: "titan-platform",
    description:
      "Reusable @titan-design/* packages arranged as a strict acyclic DAG, and the products composed from them.",
    base: "/titan-platform/",
    cleanUrls: true,

    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Get started", link: "/getting-started" },
        { text: "Packages", link: "/reference/" },
        { text: "Guides", link: "/guides/" },
      ],

      sidebar: [
        {
          text: "Docs",
          items: [
            { text: "Get started", link: "/getting-started" },
            { text: "Architecture", link: "/guides/architecture" },
            { text: "The binding pattern", link: "/guides/binding-pattern" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "All guides", link: "/guides/" },
            { text: "Case study: the session miner", link: "/guides/session-miner" },
            { text: "Case study: adopting registry and daemon", link: "/guides/adopting-a-package" },
            { text: "Working in the repo", link: "/guides/contributing" },
          ],
        },
        { text: "Packages", collapsed: false, items: [{ text: "All packages", link: "/reference/" }, ...referenceSidebar] },
      ],

      socialLinks: [{ icon: "github", link: "https://github.com/HJewkes/titan-platform" }],

      editLink: {
        pattern: "https://github.com/HJewkes/titan-platform/edit/main/site/:path",
        text: "Edit this page on GitHub",
      },

      footer: { message: "MIT licensed", copyright: "Copyright © Henry Jewkes" },

      search: { provider: "local" },
    },
  }),
);

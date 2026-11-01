import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
// Emitted by `pnpm docs:reference` from the workspace and the DAG in
// .codewatch/check.json, so a new package never needs a hand edit here.
import referenceSidebar from "./reference-sidebar.json";

// Node loads the counts loader rather than the config bundler: a literal import would inline
// scripts/gen-docs-reference.mjs, and esbuild rejects its shebang once it is no longer line 1.
const { default: homeCounts, fillCounts } = await import(new URL("../home-counts.data.mjs", import.meta.url).href);

// GitHub Pages serves this as a project site under /titan-platform/, not the
// repo root, so every asset and link needs that prefix baked in.
export default withMermaid(
  defineConfig({
    title: "titan-platform",
    description:
      "Reusable @titan-design/* packages arranged as a strict acyclic DAG, and the products composed from them.",
    base: "/titan-platform/",
    cleanUrls: true,

    transformPageData(pageData) {
      if (pageData.relativePath !== "index.md") return;
      const hero = pageData.frontmatter.hero;
      hero.tagline = fillCounts(hero.tagline, homeCounts.load());
    },

    themeConfig: {
      nav: [
        { text: "Home", link: "/" },
        { text: "Get started", link: "/getting-started" },
        { text: "Capabilities", link: "/guides/capabilities" },
        { text: "Packages", link: "/reference/" },
        { text: "Guides", link: "/guides/" },
      ],

      sidebar: [
        {
          text: "Docs",
          items: [
            { text: "Get started", link: "/getting-started" },
            { text: "Capability catalog", link: "/guides/capabilities" },
            { text: "Architecture", link: "/guides/architecture" },
            { text: "The binding pattern", link: "/guides/binding-pattern" },
            { text: "Where code goes", link: "/guides/where-code-goes" },
            { text: "Where logic goes", link: "/guides/where-logic-goes" },
            { text: "Package families", link: "/guides/package-families" },
            { text: "Multi-harness contracts", link: "/guides/multi-harness-contracts" },
          ],
        },
        {
          text: "Guides",
          items: [
            { text: "All guides", link: "/guides/" },
            { text: "Case study: the session miner", link: "/guides/session-miner" },
            { text: "Case study: adopting registry and daemon", link: "/guides/adopting-a-package" },
            { text: "Autoresearch", link: "/guides/autoresearch" },
            { text: "active-work", link: "/guides/active-work" },
            { text: "Working in the repo", link: "/guides/contributing" },
            { text: "Set up the autonomous loop", link: "/guides/autonomous-loop-setup" },
          ],
        },
        {
          text: "Running the products",
          items: [
            { text: "Factory", link: "/guides/factory" },
            { text: "Shepherd", link: "/guides/shepherd" },
            { text: "Session miner", link: "/guides/session-miner#run-it" },
            { text: "Retrieval eval", link: "/guides/retrieval-eval" },
            { text: "Code report", link: "/guides/codewatch" },
            { text: "Matrix hub", link: "/guides/hub" },
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

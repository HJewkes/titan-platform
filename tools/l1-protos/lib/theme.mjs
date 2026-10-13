// Page styling by L1_THEME: "plain" (the study's original look, in the config's pinned face), or
// "dark" / "light" on titan-design.
// The titan themes inline the real token CSS from the @titan-design/react-ui this repo already
// depends on (apps/codewatch), titan's self-hosted heading and body faces, and theme/diagram.css.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEME_DIR = path.join(HERE, "..", "theme");
const CONSUMER = path.join(HERE, "..", "..", "..", "apps", "codewatch", "package.json");

export const THEMES = ["plain", "dark", "light"];

const PLAIN = `
body{background:#2b2f36;color:#ddd}
svg.frame{background:#fff}.bg{fill:#fff}
text{fill:#1b2a41}
.r.box{fill:#fff;stroke:#4a6fa5;stroke-width:2}.r.container{fill:#f3f7fd;stroke:#4a6fa5;stroke-width:1.5}
.r.tile{fill:#f7f7f7;stroke:#888;stroke-width:1.5;stroke-dasharray:6 4}.r.chip{fill:#efe9f8;stroke:#7d5ba6;stroke-width:2}
.r.band{fill:#f6f2fb}.r.elabel{fill:#fff;stroke:#c0392b;stroke-width:1}
.lbl.head{font-weight:bold}.lbl.tile{fill:#555}.lbl.band{fill:#7d5ba6;font-style:italic}.lbl.elabel{fill:#c0392b}
.lbl.chip{fill:#4b2f73}
path.edge{fill:none;stroke:#c0392b;stroke-linejoin:round}.arrowhead{fill:#c0392b}
.chrome{fill:#1b2a41}.ref{fill:#0a7d3c}.tick{stroke:#0a7d3c;stroke-width:1}
`;

// Latin subsets only: every map label is ASCII. Weight ranges as in titan's global.css.
const FACES = [
  ["Space Grotesk", "space-grotesk-latin.woff2", "300 700"],
  ["Nunito Sans", "nunito-sans-latin.woff2", "400 700"],
];

function fontFaces() {
  return FACES.map(([family, file, weight]) => {
    const data = readFileSync(path.join(THEME_DIR, "fonts", file)).toString("base64");
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2')}`;
  }).join("\n");
}

function tokenCss() {
  return readFileSync(createRequire(CONSUMER).resolve("@titan-design/react-ui/tokens.css"), "utf8");
}

/** CSS for `theme`, plus the class the <html> element takes. */
export function themeStyles(theme) {
  if (!THEMES.includes(theme)) throw new Error(`L1_THEME must be one of ${THEMES.join(", ")}`);
  if (theme === "plain") return { css: PLAIN, htmlClass: "" };
  const css = [fontFaces(), tokenCss(), readFileSync(path.join(THEME_DIR, "diagram.css"), "utf8")].join("\n");
  return { css, htmlClass: theme === "light" ? "light" : "" };
}

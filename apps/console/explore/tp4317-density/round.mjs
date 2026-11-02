// Usage: node round.mjs <round dir> — shoots html/*.html at 390 and 1440, then writes round.json and frames/frames.json.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { QUESTIONS, SECTIONS, UNIT, variants, CONTEXT } from "./round-content.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const { chromium } = createRequire(join(HERE, "../../package.json"))("playwright-core");
const ROUND = process.argv[2];
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function shoot(browser, variant) {
  const context = await browser.newContext({ viewport: { width: variant.width, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`file://${join(HERE, "html", `${variant.page}.html`)}`);
  await page.screenshot({ path: join(ROUND, variant.image), fullPage: true });
  await context.close();
  if (errors.length > 0) throw new Error(`${variant.key}: ${errors.join("; ")}`);
}

async function main() {
  mkdirSync(join(ROUND, "frames"), { recursive: true });
  const all = variants();
  const browser = await chromium.launch();
  for (const variant of all) await shoot(browser, variant);
  await browser.close();
  const manifest = {
    schema: "titan-review/round@2",
    unit: UNIT,
    round: 1,
    storybookUrl: "http://127.0.0.1:6006",
    context: CONTEXT,
    widths: [390, 1440],
    recommendations: "shown",
    variants: all.map(({ key, image, label, variantUnit }) => ({ key, image, label, variantUnit })),
    sections: SECTIONS,
    questions: QUESTIONS,
  };
  const roundFile = join(ROUND, "round.json");
  writeFileSync(roundFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const frames = all.map(({ key, image, width }) => ({ key, file: image, sha256: sha256(join(ROUND, image)), viewport: { width } }));
  const index = { schema: "titan-review/frames@1", unit: UNIT, round: 1, manifestSha256: sha256(roundFile), frames };
  writeFileSync(join(ROUND, "frames", "frames.json"), JSON.stringify(index));
  console.log(`${roundFile}: ${frames.length} frames`);
}

await main();

const path = require("node:path");
const titanPreset = require("@titan-design/react-ui/tailwind.config.js");

// react-ui's package.json is not exported, so its dist is located through an exported file.
const reactUiDist = path.join(path.dirname(require.resolve("@titan-design/react-ui/tailwind.config.js")), "dist");

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [titanPreset],
  content: ["./index.html", "./src/**/*.{ts,tsx}", `${reactUiDist}/**/*.{js,mjs}`],
  darkMode: "class",
};

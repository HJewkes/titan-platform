import type { CommonLine } from "./common-lines.js";

/** Lines main allows in the "install-then-use" family. */
export const installLines: readonly CommonLine[] = [
  {
    id: "H01",
    family: "install-then-use",
    line: 'npm ci && PATH="./node_modules/.bin:$PATH" eslint .',
  },
  {
    id: "H02",
    family: "install-then-use",
    line: 'pnpm install; export PATH="$PWD/node_modules/.bin:$PATH"; tsc --noEmit',
  },
  {
    id: "H03",
    family: "install-then-use",
    line: "go build -o bin/tool . && PATH=./bin:$PATH tool --help",
  },
  {
    id: "H04",
    family: "install-then-use",
    line: 'make; export PATH="$PWD/bin:$PATH"; mytool',
  },
  {
    id: "H05",
    family: "install-then-use",
    line: 'npm install && export PATH="$(npm bin):$PATH" && jest',
  },
  {
    id: "H06",
    family: "install-then-use",
    line: 'cd frontend && npm ci && PATH="$PWD/node_modules/.bin:$PATH" vite build',
  },
  {
    id: "H07",
    family: "install-then-use",
    line: 'python -m venv .venv && export PATH="$PWD/.venv/bin:$PATH" && pip install -r requirements.txt',
  },
  {
    id: "H08",
    family: "install-then-use",
    line: 'bundle install --binstubs && PATH="./bin:$PATH" rspec',
  },
  {
    id: "H09",
    family: "install-then-use",
    line: 'export PATH="$PWD/bin:$PATH"; make',
  },
  {
    id: "H10",
    family: "install-then-use",
    line: 'git pull; export PATH="$HOME/bin:$PATH"; deploy-check',
  },
];

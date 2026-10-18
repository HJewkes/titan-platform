import type { CommonLine } from "./common-lines.js";

/** Lines main allows in the "toolchain PATH exports" family. */
export const toolchainLines: readonly CommonLine[] = [
  {
    id: "C01",
    family: "toolchain PATH exports",
    line: 'export PATH="$JAVA_HOME/bin:$PATH"; java -version',
  },
  {
    id: "C02",
    family: "toolchain PATH exports",
    line: 'export PATH="$GOPATH/bin:$PATH"; go test ./...',
  },
  {
    id: "C03",
    family: "toolchain PATH exports",
    line: 'export PATH="$VIRTUAL_ENV/bin:$PATH"; python x.py',
  },
  {
    id: "C04",
    family: "toolchain PATH exports",
    line: 'export PATH="$PNPM_HOME:$PATH"; pnpm install',
  },
  {
    id: "C05",
    family: "toolchain PATH exports",
    line: 'export PATH="$CARGO_HOME/bin:$PATH"; cargo build',
  },
  {
    id: "C06",
    family: "toolchain PATH exports",
    line: 'export PATH="$(go env GOPATH)/bin:$PATH"; golangci-lint run',
  },
  {
    id: "C07",
    family: "toolchain PATH exports",
    line: 'export PATH="$(npm bin):$PATH"; eslint .',
  },
  {
    id: "C08",
    family: "toolchain PATH exports",
    line: 'export PATH="$(brew --prefix)/bin:$PATH"; jq . f.json',
  },
  {
    id: "C09",
    family: "toolchain PATH exports",
    line: 'export PATH="$(pwd)/bin:$PATH"; make',
  },
  {
    id: "C10",
    family: "toolchain PATH exports",
    line: "PATH=$(getconf PATH) ls",
  },
  {
    id: "C11",
    family: "toolchain PATH exports",
    line: "P=.; export PATH=$P:$PATH; ls",
  },
  {
    id: "C12",
    family: "toolchain PATH exports",
    line: 'export PATH="$HOME/bin:$PATH"; ./build.sh',
  },
  {
    id: "C13",
    family: "toolchain PATH exports",
    line: 'export PATH="$HOME/.local/bin:$PATH"; black .',
  },
  {
    id: "C14",
    family: "toolchain PATH exports",
    line: 'export PATH="$PWD/node_modules/.bin:$PATH"; tsc --noEmit',
  },
  {
    id: "C15",
    family: "toolchain PATH exports",
    line: 'PATH="./node_modules/.bin:$PATH" eslint .',
  },
  {
    id: "C16",
    family: "toolchain PATH exports",
    line: "export PATH=$PATH:/usr/local/go/bin; go version",
  },
  {
    id: "C17",
    family: "toolchain PATH exports",
    line: "source .venv/bin/activate; python -m pytest",
  },
  {
    id: "C18",
    family: "toolchain PATH exports",
    line: '. "$HOME/.cargo/env"; cargo test',
  },
  {
    id: "C19",
    family: "toolchain PATH exports",
    line: 'eval "$(pyenv init -)"; python --version',
  },
  {
    id: "C21",
    family: "toolchain PATH exports",
    line: 'export PATH="$ANDROID_HOME/platform-tools:$PATH"; adb devices',
  },
  {
    id: "C22",
    family: "toolchain PATH exports",
    line: 'PATH="$HOME/go/bin:$PATH" go run .',
  },
  {
    id: "C23",
    family: "toolchain PATH exports",
    line: 'export PATH="${PATH}:${HOME}/.npm-global/bin"; npm ls',
  },
  {
    id: "C24",
    family: "toolchain PATH exports",
    line: 'export PATH="$(yarn global bin):$PATH"; yarn build',
  },
  {
    id: "C25",
    family: "toolchain PATH exports",
    line: 'export PATH="$NVM_BIN:$PATH" && node -v',
  },
  {
    id: "C26",
    family: "toolchain PATH exports",
    line: 'export PATH="$(dirname "$(which python3)"):$PATH"; pip list',
  },
  {
    id: "C27",
    family: "toolchain PATH exports",
    line: 'env PATH="$PWD/bin:$PATH" make test',
  },
  {
    id: "C28",
    family: "toolchain PATH exports",
    line: 'export PATH="$JAVA_HOME/bin:$PATH"; ./gradlew build',
  },
  {
    id: "C29",
    family: "toolchain PATH exports",
    line: 'export PATH="$(go env GOPATH)/bin:$PATH"; go install x@latest && x --help',
  },
  {
    id: "N01",
    family: "toolchain PATH exports",
    line: 'PATH="./node_modules/.bin:$PATH" eslint .',
  },
  {
    id: "N02",
    family: "toolchain PATH exports",
    line: 'PATH="./node_modules/.bin:$PATH" tsc --noEmit',
  },
  {
    id: "N03",
    family: "toolchain PATH exports",
    line: 'export PATH="$PWD/node_modules/.bin:$PATH"; vitest run',
  },
  {
    id: "N04",
    family: "toolchain PATH exports",
    line: "npm ci && PATH=./node_modules/.bin:$PATH prettier --check .",
  },
  {
    id: "N05",
    family: "toolchain PATH exports",
    line: 'export PATH="$(npm bin):$PATH"; tsc -v',
  },
];

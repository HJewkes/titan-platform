import { noInternalModuleMock } from "./no-internal-module-mock.js";
import { tsRuleTester } from "./test-fixtures.js";

function message(call: string, specifier: string): string {
  return `\`${call}("${specifier}")\` mocks this repo's own code, so the test stops exercising it. Mock only external dependencies (node: builtins, third-party packages): pass the dependency in as a parameter, or use the package's own fake.`;
}

tsRuleTester.run("no-internal-module-mock", noInternalModuleMock, {
  valid: [
    { name: "a node: builtin", code: 'vi.mock("node:child_process", () => ({ execFile }));' },
    { name: "a bare builtin", code: 'vi.mock("fs");' },
    { name: "a third-party package", code: 'vi.mock("octokit");' },
    { name: "a scoped third-party package", code: 'vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js");' },
    { name: "a scope that only starts like the internal one", code: 'vi.mock("@titan-designs/x");' },
    { name: "a dynamic specifier is not judged", code: "vi.mock(path);" },
    { name: "a template literal with an expression is not judged", code: "vi.mock(`./${name}.js`);" },
    { name: "vi.fn is not a module mock", code: 'vi.fn("./x");' },
    { name: "vi.unmock restores a module", code: 'vi.unmock("./x.js");' },
    { name: "another object's mock method", code: 'server.mock("./x.js");' },
    { name: "importActual reads the real module", code: 'await vi.importActual("@titan-design/daemon");' },
    {
      name: "a configured prefix replaces the default",
      code: 'vi.mock("@titan-design/daemon");',
      options: [{ internalPrefixes: ["@codewatch/"] }],
    },
  ],
  invalid: [
    { name: "a relative module", code: 'vi.mock("./host.js");', errors: [{ message: message("vi.mock", "./host.js") }] },
    { name: "a parent-relative module", code: 'vi.mock("../runners/eslint-runner.js", () => ({}));', errors: [{ message: message("vi.mock", "../runners/eslint-runner.js") }] },
    { name: "a workspace package", code: 'vi.mock("@titan-design/authority");', errors: [{ message: message("vi.mock", "@titan-design/authority") }] },
    { name: "a workspace package subpath", code: 'vi.mock("@titan-design/daemon/http");', errors: [{ message: message("vi.mock", "@titan-design/daemon/http") }] },
    { name: "a subpath import", code: 'vi.mock("#internal/git");', errors: [{ message: message("vi.mock", "#internal/git") }] },
    { name: "an absolute path", code: 'vi.mock("/src/git.js");', errors: [{ message: message("vi.mock", "/src/git.js") }] },
    { name: "vi.doMock", code: 'vi.doMock("./git.js");', errors: [{ message: message("vi.doMock", "./git.js") }] },
    { name: "jest.mock", code: 'jest.mock("./git.js");', errors: [{ message: message("jest.mock", "./git.js") }] },
    { name: "jest.unstable_mockModule", code: 'jest.unstable_mockModule("./git.js", () => ({}));', errors: [{ message: message("jest.unstable_mockModule", "./git.js") }] },
    { name: "a computed method name", code: 'vi["mock"]("./git.js");', errors: [{ message: message("vi.mock", "./git.js") }] },
    { name: "a template literal without expressions", code: "vi.mock(`./git.js`);", errors: [{ message: message("vi.mock", "./git.js") }] },
    { name: "vitest's import() form", code: 'vi.mock(import("./git.js"));', errors: [{ message: message("vi.mock", "./git.js") }] },
    {
      name: "a configured prefix",
      code: 'vi.mock("@codewatch/core");',
      options: [{ internalPrefixes: ["@codewatch/"] }],
      errors: [{ message: message("vi.mock", "@codewatch/core") }],
    },
  ],
});

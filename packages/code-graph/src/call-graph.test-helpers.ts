import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** TypeScript fixture: intra-file, barrel-imported, external, `new`, `this.` and top-level calls. */
export const TS_FILES: Record<string, string> = {
  "src/ts/util.ts":
    "export function origin(flag: boolean, mode: string, n?: number): number {\n" +
    "  return flag ? mode.length : (n ?? 0);\n}\n",
  "src/ts/barrel.ts": 'export { origin } from "./util.js";\n',
  "src/ts/main.ts": `import { origin } from "./barrel.js";
import { ext } from "extpkg";

function helper(x: number): number { return x + 1; }
function shared(x: number): number { return x * 2; }
export function exportedOnce(): number { return 1; }
function lonely(a: number, b: string): number { return a + b.length; }

class Box {
  size(): number { return this.inner(); }
  inner(): number { return 3; }
}

export function run(): number {
  const b = new Box();
  return helper(1) + shared(2) + exportedOnce() + origin(true, "fast") + ext(1) + b.size() + lonely(1, "x");
}

export function walk(): number {
  return shared(3) + origin(true, "slow");
}

export const START = run();
`,
  "node_modules/extpkg/package.json": '{ "name": "extpkg", "types": "index.d.ts" }\n',
  "node_modules/extpkg/index.d.ts": "export declare function ext(a: number): number;\n",
};

/** Python fixture: the three resolvable call forms plus the forms that must be dropped. */
export const PY_FILES: Record<string, string> = {
  "py/helpers.py": "def shared_util(a, b=1):\n    return a + b\n",
  "py/app.py": `import helpers
from helpers import shared_util
from helpers import shared_util as su


def _local(x):
    return x


class Job:
    def run(self):
        return self._step(1)

    def _step(self, n):
        return n


def entry(obj):
    _local(1)
    shared_util(2)
    su(4)
    helpers.shared_util(3)
    obj.thing.call()
    return Job().run()


def shadow(_local):
    return _local(5)


class Base:
    def _shared_step(self):
        return 0


class Child(Base):
    def go(self):
        return self._shared_step()
`,
};

export async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-calls-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  return root;
}

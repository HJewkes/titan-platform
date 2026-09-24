import { describe, expect, it } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { computeSourceMetrics } from "../source-metrics.js";

const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

async function fileMetrics(code: string, lang: "typescript" | "python"): Promise<Record<string, number | null>> {
  const fp = lang === "python" ? "f.py" : "f.ts";
  const metrics = computeSourceMetrics([await parseFile(code, fp, lang)], (p) => p);
  const pick = (name: string) => metrics.find((m) => m.nodeId === fp && m.name === name)?.value ?? null;
  return { count: pick("except_count"), density: pick("except_density"), swallowed: pick("swallowed_except") };
}

describe("exception-handling metrics on Python (TP-322)", () => {
  it("counts every except clause and the swallowed ones", async () => {
    const code = lines(
      "def f(xs):",
      "    for x in xs:",
      "        try:",
      "            use(x)",
      "        except KeyError:",
      "            continue",
      "        except ValueError:",
      "            ...",
      "        except OSError as e:",
      "            logger.warning('skip %s', e)",
      "        except TypeError:",
      "            raise",
      "    try:",
      "        done()",
      "    except Exception:",
      "        return None",
    );
    expect(await fileMetrics(code, "python")).toEqual({ count: 5, density: (5 * 100) / 16, swallowed: 4 });
  });

  it("does not count a handler that recovers, re-raises or does more than log", async () => {
    const code = lines(
      "try:",
      "    x = load()",
      "except KeyError:",
      "    x = default()",
      "except ValueError as e:",
      "    log.error(e)",
      "    raise",
      "except OSError:",
      "    catalog.add(path)",
    );
    expect(await fileMetrics(code, "python")).toMatchObject({ count: 3, swallowed: 0 });
  });

  it("writes zeros on a file with no handlers", async () => {
    expect(await fileMetrics("x = 1\n", "python")).toEqual({ count: 0, density: 0, swallowed: 0 });
  });
});

describe("exception-handling exempts the optional-import idiom (TP-340)", () => {
  it("except ImportError: pass is not swallowed", async () => {
    const code = lines("try:", "    import foo", "except ImportError:", "    pass");
    expect(await fileMetrics(code, "python")).toMatchObject({ count: 1, swallowed: 0 });
  });

  it("except (ImportError, ModuleNotFoundError): pass is not swallowed", async () => {
    const code = lines("try:", "    import foo", "except (ImportError, ModuleNotFoundError):", "    pass");
    expect(await fileMetrics(code, "python")).toMatchObject({ count: 1, swallowed: 0 });
  });

  it("except (ImportError, ValueError): pass is still swallowed — the tuple carries a non-import type", async () => {
    const code = lines("try:", "    import foo", "except (ImportError, ValueError):", "    pass");
    expect(await fileMetrics(code, "python")).toMatchObject({ count: 1, swallowed: 1 });
  });

  it("except Exception: pass is still swallowed — regression guard for unrelated types", async () => {
    const code = lines("try:", "    risky()", "except Exception:", "    pass");
    expect(await fileMetrics(code, "python")).toMatchObject({ count: 1, swallowed: 1 });
  });

  it("except ImportError: X = None is treated the same as except ImportError: pass", async () => {
    const code = lines("try:", "    import foo", "except ImportError:", "    foo = None");
    expect(await fileMetrics(code, "python")).toMatchObject({ count: 1, swallowed: 0 });
  });
});

describe("exception-handling metrics on TypeScript (TP-322)", () => {
  it("counts catch clauses and treats empty, comment-only, bare-return and console-only bodies as swallowed", async () => {
    const code = lines(
      "export function f() {",
      "  try { a(); } catch {}",
      "  try { b(); } catch (e) { /* best effort */ }",
      "  try { c(); } catch (e) { return; }",
      "  try { d(); } catch (e) { console.error(e); }",
      "  try { e(); } catch (err) { throw new Wrapped(err); }",
      "}",
    );
    expect(await fileMetrics(code, "typescript")).toMatchObject({ count: 5, swallowed: 4 });
  });

  it("does not treat a returned fallback value as swallowed", async () => {
    const code = "function f() {\n  try { return a(); } catch { return fallback; }\n}\n";
    expect(await fileMetrics(code, "typescript")).toMatchObject({ count: 1, swallowed: 0 });
  });
});

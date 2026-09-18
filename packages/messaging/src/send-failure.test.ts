import { describe, expect, it } from "vitest";
import { attemptFetch, classifyThrownSend } from "./send-failure.js";

/** The shape Node's undici fetch throws: a bare TypeError with the coded socket error on `cause`. */
function undiciFailure(code: string, name = "Error"): TypeError {
  const cause = Object.assign(new Error(`${code} from the socket`), { code, name });
  return new TypeError("fetch failed", { cause });
}

function happyEyeballsRefusal(): TypeError {
  const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const cause = Object.assign(new AggregateError([refused(), refused()], ""), {
    code: "ECONNREFUSED",
  });
  return new TypeError("fetch failed", { cause });
}

describe("classifyThrownSend", () => {
  it.each([
    ["connection refused", "unreachable", undiciFailure("ECONNREFUSED")],
    ["refused on every address of a dual-stack host", "unreachable", happyEyeballsRefusal()],
    ["DNS name not found", "unreachable", undiciFailure("ENOTFOUND")],
    ["DNS temporary failure", "unreachable", undiciFailure("EAI_AGAIN")],
    ["connect timeout", "unreachable", undiciFailure("UND_ERR_CONNECT_TIMEOUT", "ConnectTimeoutError")],
    ["reset after write", "indeterminate", undiciFailure("ECONNRESET")],
    ["other side closed after write", "indeterminate", undiciFailure("UND_ERR_SOCKET", "SocketError")],
    ["timeout awaiting headers", "indeterminate", undiciFailure("UND_ERR_HEADERS_TIMEOUT")],
    ["timeout awaiting body", "indeterminate", undiciFailure("UND_ERR_BODY_TIMEOUT")],
    ["socket timeout on an open connection", "indeterminate", undiciFailure("ETIMEDOUT")],
    ["route lost mid-request", "indeterminate", undiciFailure("EHOSTUNREACH")],
    ["abort signal timeout", "indeterminate", new DOMException("aborted due to timeout", "TimeoutError")],
    ["abort while awaiting the response", "indeterminate", new DOMException("aborted", "AbortError")],
    ["uncoded fetch failed", "indeterminate", new TypeError("fetch failed")],
    ["Workers network loss", "indeterminate", new TypeError("Network connection lost.")],
    ["a thrown string", "indeterminate", "socket hang up"],
    ["a thrown null", "indeterminate", null],
  ])("classifies %s as %s", (_scenario, expected, thrown) => {
    const kind = classifyThrownSend(thrown);

    expect(kind).toBe(expected);
  });

  it("decides on the outermost code, not a refused connection further down", () => {
    const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const reset = Object.assign(new Error("reset", { cause: refused }), { code: "ECONNRESET" });

    const kind = classifyThrownSend(new TypeError("fetch failed", { cause: reset }));

    expect(kind).toBe("indeterminate");
  });
});

describe("attemptFetch", () => {
  it("reports a throw while preparing the request as unreachable without calling fetch", async () => {
    let called = false;
    const doFetch: typeof fetch = async () => {
      called = true;
      return new Response();
    };

    const attempt = await attemptFetch(doFetch, () => [new URL("not a url")]);

    expect(attempt).toMatchObject({ sent: false, kind: "unreachable" });
    expect(called).toBe(false);
  });

  it("classifies a throw from fetch itself", async () => {
    const doFetch: typeof fetch = async () => {
      throw undiciFailure("ECONNRESET");
    };

    const attempt = await attemptFetch(doFetch, () => ["https://example.test/"]);

    expect(attempt).toMatchObject({ sent: false, kind: "indeterminate" });
  });

  it("hands back the response when fetch resolves", async () => {
    const response = new Response("{}", { status: 502 });

    const attempt = await attemptFetch(async () => response, () => ["https://example.test/"]);

    expect(attempt).toEqual({ sent: true, response });
  });
});

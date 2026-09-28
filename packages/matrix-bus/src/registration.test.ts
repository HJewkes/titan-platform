import { describe, expect, it } from "vitest";
import { renderRegistration, type RegistrationOptions } from "./registration.js";

const edge1: RegistrationOptions = {
  id: "titan-edge1",
  asToken: "as-secret",
  hsToken: "hs-secret",
  url: null,
  senderLocalpart: "ac-edge1",
  machine: "edge1",
  serverName: "chat.example.org",
};

describe("renderRegistration", () => {
  it("renders a receive-only edge with a machine-pinned, dot-escaped namespace", () => {
    expect(renderRegistration(edge1)).toBe(
      [
        'id: "titan-edge1"',
        "url: null",
        'as_token: "as-secret"',
        'hs_token: "hs-secret"',
        "sender_localpart: ac-edge1",
        "rate_limited: false",
        "namespaces:",
        "  users:",
        "    - exclusive: true",
        '      regex: "^@ac-edge1-.*:chat\\\\.example\\\\.org$"',
        "  aliases: []",
        "  rooms: []",
        "",
      ].join("\n"),
    );
  });

  it("quotes a push url when the appservice receives transactions", () => {
    expect(renderRegistration({ ...edge1, url: "http://core:9009" })).toContain('url: "http://core:9009"');
  });

  it("refuses a machine name that could overlap another machine's prefix", () => {
    expect(() => renderRegistration({ ...edge1, machine: "edge1-.*" })).toThrow(/machine/);
  });
});

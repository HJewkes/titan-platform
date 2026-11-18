// @vitest-environment node
import { describe, expect, it } from "vitest";
import { render } from "./entry-server.js";

describe("the server render of the docs root", () => {
  it("carries the top bar as the banner landmark", () => {
    const { html } = render("");

    expect(html).toMatch(/<header role="banner"[^>]*>[\s\S]*TITAN PLATFORM[\s\S]*<\/header>/);
  });

  it("renders every nav entry as a real link under the site base", () => {
    const { html } = render("");

    expect(html).toContain('href="/titan-platform/getting-started"');
    expect(html).toContain('href="/titan-platform/guides/"');
    expect(html).toMatch(/<a [^>]*href="\/titan-platform\/reference\/"/);
  });

  it("renders no button that pretends to be a link", () => {
    const { html } = render("");

    expect(html).not.toContain("<button href");
  });

  it("puts the react-native-web atomic rules in a head style tag", () => {
    const { head } = render("");

    expect(head).toMatch(/^<style id="react-native-stylesheet">[\s\S]*\.r-[\w-]+\{[\s\S]*<\/style>$/);
  });
});

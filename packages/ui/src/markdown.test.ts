import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  test("renders markdown", () => {
    expect(renderMarkdown("# Title\n\n*hi*")).toContain("<h1>Title</h1>");
  });

  test("raw HTML from a README is shown as text", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\nok <img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&#60;script&#62;");
  });

  test("only http(s), mailto and in-page links survive", () => {
    const html = renderMarkdown(
      "[a](javascript:alert(1)) [b](https://example.com) [c](mailto:x@y.z) [d](#top) [e](//evil.test)",
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("//evil.test");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:x@y.z"');
    expect(html).toContain('href="#top"');
  });

  test("relative links and images resolve inside the repo", () => {
    const resolve = (path: string) =>
      `https://data.test/api/download?path=wiki%2F${encodeURIComponent(path)}`;
    const html = renderMarkdown("[license](./LICENSE) ![chart](plots/a.png)", resolve);
    expect(html).toContain('href="https://data.test/api/download?path=wiki%2FLICENSE"');
    expect(html).toContain('src="https://data.test/api/download?path=wiki%2Fplots%2Fa.png"');
    // Without a resolver, relative links are dropped rather than pointing somewhere wrong.
    expect(renderMarkdown("[x](data.csv)")).not.toContain("href");
  });
});

import { Marked, type Tokens } from "marked";

/**
 * README markdown to HTML. READMEs are repo content, so raw HTML is shown as
 * text and only http(s), mailto and in-page links survive. Relative links and
 * images resolve through `resolve`, so README.md can point at files next to it
 * in the repo.
 */
export function renderMarkdown(text: string, resolve?: (path: string) => string): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const target = (href: string): string | null => {
    const h = href.trim();
    if (/^(https?:|mailto:)/i.test(h) || h.startsWith("#")) return h;
    if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//")) return null;
    if (!resolve) return null;
    const [path, hash] = h.split("#", 2);
    return resolve(path!.replace(/^\.\//, "")) + (hash ? `#${hash}` : "");
  };

  const marked = new Marked({
    gfm: true,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escape(text);
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const url = target(href);
        if (!url) return inner;
        const t = title ? ` title="${escape(title)}"` : "";
        return `<a href="${escape(url)}"${t} rel="nofollow noopener">${inner}</a>`;
      },
      image({ href, title, text }: Tokens.Image) {
        const url = target(href);
        if (!url) return escape(text);
        const t = title ? ` title="${escape(title)}"` : "";
        return `<img src="${escape(url)}" alt="${escape(text)}"${t} loading="lazy" />`;
      },
    },
  });
  return marked.parse(text, { async: false });
}

/** sha256 of bytes, as hex, in the browser. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

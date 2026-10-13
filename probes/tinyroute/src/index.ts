export type Params = Record<string, string>;
export type Context = { params: Params; url: URL; query: URLSearchParams };
export type Handler = (req: Request, ctx: Context) => Response | Promise<Response>;

type Route = { method: string; pattern: string; segments: string[]; handler: Handler };

const split = (path: string) => path.split("/").filter(Boolean);

function match(segments: string[], parts: string[]): Params | null {
  const params: Params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "*") {
      params["*"] = parts.slice(i).map(decodeURIComponent).join("/");
      return params;
    }
    const part = parts[i];
    if (part === undefined) return null;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
    else if (seg !== part) return null;
  }
  return segments.length === parts.length ? params : null;
}

export class Router {
  private routes: Route[] = [];
  private fallback: Handler = () => new Response("Not Found", { status: 404 });

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), pattern, segments: split(pattern), handler });
    return this;
  }

  get(p: string, h: Handler) { return this.on("GET", p, h); }
  post(p: string, h: Handler) { return this.on("POST", p, h); }
  put(p: string, h: Handler) { return this.on("PUT", p, h); }
  delete(p: string, h: Handler) { return this.on("DELETE", p, h); }

  notFound(h: Handler): this {
    this.fallback = h;
    return this;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = split(url.pathname);
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const params = match(route.segments, parts);
      if (!params) continue;
      if (route.method === req.method || (route.method === "GET" && req.method === "HEAD")) {
        return route.handler(req, { params, url, query: url.searchParams });
      }
      allowed.add(route.method);
    }
    if (allowed.size > 0) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: [...allowed].join(", ") },
      });
    }
    return this.fallback(req, { params: {}, url, query: url.searchParams });
  }
}

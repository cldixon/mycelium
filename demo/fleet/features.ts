/**
 * The fleet's work: small, real features for tinyroute (the seed repo in `seed/`), each a change
 * to its source plus a test. A change is a function of the files as they are, applied by anchor
 * (an exact line or snippet it expects to find), so an agent can re-apply it on a newer base after
 * someone else's merge: that is how a fleet agent "rebases" deterministically.
 *
 * `regions` name the parts of the code a change touches. Two features that share a region
 * conflict when both merge; the realistic scenario picks one such pair on purpose and keeps every
 * other feature in a run apart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Files {
  read(path: string): string;
  write(path: string, text: string): void;
  exists(path: string): boolean;
}

/** Files of a working tree on disk. */
export function dirFiles(dir: string): Files {
  return {
    read: (p) => readFileSync(join(dir, p), "utf8"),
    write: (p, text) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    },
    exists: (p) => existsSync(join(dir, p)),
  };
}

export class AnchorError extends Error {}

/** Replace one exact snippet; throws if the code no longer has it. */
function edit(f: Files, path: string, find: string, replace: string) {
  const src = f.read(path);
  if (!src.includes(find)) {
    throw new AnchorError(`${path} no longer contains ${JSON.stringify(find.trim().slice(0, 60))}`);
  }
  f.write(
    path,
    src.replace(find, () => replace),
  );
}

/** Replace the first match of a pattern; throws if there is none. */
function editRe(f: Files, path: string, find: RegExp, replace: string) {
  const src = f.read(path);
  if (!find.test(src)) throw new AnchorError(`${path} no longer matches ${find}`);
  f.write(
    path,
    src.replace(find, () => replace),
  );
}

const after = (f: Files, path: string, anchor: string, text: string) =>
  edit(f, path, anchor, anchor + text);
const before = (f: Files, path: string, anchor: string, text: string) =>
  edit(f, path, anchor, text + anchor);

export type Role = "clean" | "breaker" | "pair";

export interface Feature {
  /** Short id: the branch is `<agent>/<id>`. */
  id: string;
  title: string;
  body: string;
  /** Code regions the change touches (see the file comment). */
  regions: string[];
  /** Roles this feature can play: breaker (first push fails CI), pair (the conflicting pair). */
  roles: Role[];
  /** Its own test file; on main it means the feature already landed. */
  test: string;
  /** The correct change. */
  apply(f: Files): void;
  /** Breakers: the first attempt, which passes its own test but breaks an existing one. */
  buggy?(f: Files): void;
  /** Breakers: turns the buggy attempt into the correct one. */
  fix?(f: Files): void;
  fixMessage?: string;
  /** The author's note on its own pull request. */
  note: string;
  /** What another agent says when it reviews this pull request. */
  review: string;
}

const INDEX = "src/index.ts";
const DELETE_LINE = `  delete(p: string, h: Handler) { return this.on("DELETE", p, h); }\n`;
const HANDLE_LINE = `  async handle(req: Request): Promise<Response> {\n`;
const FALLBACK_FIELD = `  private fallback: Handler = () => new Response("Not Found", { status: 404 });\n`;
const DISPATCH_IF = `if (route.method === req.method || (`;
const DISPATCH_RETURN = `        return route.handler(req, { params, url, query: url.searchParams });\n`;
const ALLOWED_IF = `    if (allowed.size > 0) {\n`;
const PART_MISSING = `    if (part === undefined) return null;\n`;
const PARAM_ASSIGN =
  /    if \(seg\.startsWith\(":"\)\) params\[[^\n]*\] = decodeURIComponent\(part\);\n    else if \(seg !== part\) return null;\n/;
const PLAIN_NAME = `params[seg.slice(1)] = decodeURIComponent(part);`;
const CONSTRAINT = String.raw`/^:(\w+)(?:\((.+)\))?\??$/`;
const CONSTRAINT_BUGGY = String.raw`/^:(\w+)\((.+)\)\??$/`;
const MATCH_END = `  return segments.length === parts.length ? params : null;\n`;

const header = `import { describe, expect, test } from "bun:test";\n`;
const req = `const req = (method: string, path: string, init?: RequestInit) =>
  new Request(\`http://x\${path}\`, { method, ...init });
`;

export const FEATURES: Feature[] = [
  {
    id: "redirect-helper",
    title: "Add a redirect() response helper",
    body: "Handlers keep writing `new Response(null, { status: 302, headers: { Location } })`. This adds `redirect(location, status = 302)` in `src/redirect.ts`, with a test.",
    regions: ["file:redirect"],
    roles: ["clean"],
    test: "test/redirect.test.ts",
    apply(f) {
      f.write(
        "src/redirect.ts",
        `/** A redirect: 302 by default; 301 or 308 for permanent moves, 303 after a POST, 307 to keep the method. */
export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}
`,
      );
      f.write(
        this.test,
        `${header}import { redirect } from "../src/redirect";

describe("redirect", () => {
  test("302 with Location by default", () => {
    const res = redirect("/login");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  test("permanent", () => {
    expect(redirect("/new", 308).status).toBe(308);
  });
});
`,
      );
    },
    note: "Small helper, no changes to the router itself. `bun test` passes locally.",
    review:
      "Looked through `src/redirect.ts`: the status union keeps callers honest. LGTM once `test` is green.",
  },
  {
    id: "json-body",
    title: "Add readJson(): parse a JSON request body safely",
    body: "`await req.json()` throws on an empty or malformed body. `readJson(req)` in `src/body.ts` returns `null` instead, and checks the content type.",
    regions: ["file:body"],
    roles: ["clean"],
    test: "test/body.test.ts",
    apply(f) {
      f.write(
        "src/body.ts",
        `/** The request's JSON body, or null when it isn't JSON or doesn't parse. */
export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return null;
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
`,
      );
      f.write(
        this.test,
        `${header}import { readJson } from "../src/body";

const post = (body: string, type = "application/json") =>
  new Request("http://x/", { method: "POST", body, headers: { "content-type": type } });

describe("readJson", () => {
  test("parses JSON", async () => {
    expect(await readJson(post('{"a":1}'))).toEqual({ a: 1 });
  });

  test("null for malformed JSON", async () => {
    expect(await readJson(post("{"))).toBeNull();
  });

  test("null for other content types", async () => {
    expect(await readJson(post("a=1", "application/x-www-form-urlencoded"))).toBeNull();
  });
});
`,
      );
    },
    note: "No router changes; three tests for the happy path, bad JSON and the wrong content type.",
    review:
      "Returning `null` rather than throwing reads well in handlers. One nit for later: a size cap.",
  },
  {
    id: "query-helpers",
    title: "Add typed query helpers: queryInt() and queryFlag()",
    body: "Pagination handlers parse `?limit=` by hand. `queryInt(query, name, fallback)` and `queryFlag(query, name)` in `src/query.ts`.",
    regions: ["file:query"],
    roles: ["clean"],
    test: "test/query.test.ts",
    apply(f) {
      f.write(
        "src/query.ts",
        `/** An integer query parameter, or the fallback when it is missing or not an integer. */
export function queryInt(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null || !/^-?\\d+$/.test(raw)) return fallback;
  return Number(raw);
}

/** A boolean flag: present and not "0" or "false". */
export function queryFlag(query: URLSearchParams, name: string): boolean {
  const raw = query.get(name);
  return raw !== null && raw !== "0" && raw.toLowerCase() !== "false";
}
`,
      );
      f.write(
        this.test,
        `${header}import { queryFlag, queryInt } from "../src/query";

const q = (s: string) => new URLSearchParams(s);

describe("query helpers", () => {
  test("queryInt parses integers", () => {
    expect(queryInt(q("limit=25"), "limit", 10)).toBe(25);
  });

  test("queryInt falls back", () => {
    expect(queryInt(q("limit=lots"), "limit", 10)).toBe(10);
    expect(queryInt(q(""), "limit", 10)).toBe(10);
  });

  test("queryFlag", () => {
    expect(queryFlag(q("draft"), "draft")).toBe(true);
    expect(queryFlag(q("draft=false"), "draft")).toBe(false);
    expect(queryFlag(q(""), "draft")).toBe(false);
  });
});
`,
      );
    },
    note: "Helpers only. Fallbacks cover missing and malformed values.",
    review:
      "Nice and small. `queryFlag` treating a bare `?draft` as true matches what browsers send.",
  },
  {
    id: "cookies",
    title: "Add cookie helpers",
    body: "`parseCookies(req)` and `serializeCookie(name, value, options)` in `src/cookies.ts`, for sessions in handlers.",
    regions: ["file:cookies"],
    roles: ["clean"],
    test: "test/cookies.test.ts",
    apply(f) {
      f.write(
        "src/cookies.ts",
        `/** The request's cookies by name. */
export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export type CookieOptions = { maxAge?: number; path?: string; httpOnly?: boolean; secure?: boolean };

/** A Set-Cookie header value. */
export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const parts = [\`\${name}=\${encodeURIComponent(value)}\`, \`Path=\${o.path ?? "/"}\`];
  if (o.maxAge !== undefined) parts.push(\`Max-Age=\${o.maxAge}\`);
  if (o.httpOnly ?? true) parts.push("HttpOnly");
  if (o.secure ?? true) parts.push("Secure");
  return parts.join("; ");
}
`,
      );
      f.write(
        this.test,
        `${header}import { parseCookies, serializeCookie } from "../src/cookies";

describe("cookies", () => {
  test("parse", () => {
    const req = new Request("http://x/", { headers: { cookie: "a=1; session=x%20y" } });
    expect(parseCookies(req)).toEqual({ a: "1", session: "x y" });
  });

  test("serialize with safe defaults", () => {
    expect(serializeCookie("s", "v", { maxAge: 60 })).toBe("s=v; Path=/; Max-Age=60; HttpOnly; Secure");
  });
});
`,
      );
    },
    note: "HttpOnly and Secure are on by default; opt out explicitly.",
    review: "Safe defaults are the right call. Worth a SameSite option in a follow-up.",
  },
  {
    id: "cors",
    title: "Add a withCors() wrapper",
    body: "`withCors(handler, origin)` in `src/cors.ts` adds `Access-Control-Allow-Origin` to a handler's responses.",
    regions: ["file:cors"],
    roles: ["clean"],
    test: "test/cors.test.ts",
    apply(f) {
      f.write(
        "src/cors.ts",
        `import type { Handler } from "./index";

/** Wrap a handler so its responses allow cross-origin reads from \`origin\`. */
export function withCors(handler: Handler, origin = "*"): Handler {
  return async (req, ctx) => {
    const res = await handler(req, ctx);
    const out = new Response(res.body, res);
    out.headers.set("Access-Control-Allow-Origin", origin);
    if (origin !== "*") out.headers.append("Vary", "Origin");
    return out;
  };
}
`,
      );
      f.write(
        this.test,
        `${header}import { Router } from "../src/index";
import { withCors } from "../src/cors";

describe("withCors", () => {
  test("adds the header", async () => {
    const app = new Router().get("/", withCors(() => new Response("ok"), "https://a.example"));
    const res = await app.handle(new Request("http://x/"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://a.example");
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(await res.text()).toBe("ok");
  });
});
`,
      );
    },
    note: "A wrapper rather than router state, so routes opt in one by one.",
    review: "Wrapping per handler keeps the router lean. `Vary: Origin` is a good catch.",
  },
  {
    id: "route-groups",
    title: "Add route groups: group(prefix, register)",
    body: '`app.group("/api", (r) => r.get("/users/:id", h))` registers routes under a shared prefix.',
    regions: ["before-handle"],
    roles: ["clean"],
    test: "test/groups.test.ts",
    apply(f) {
      before(
        f,
        INDEX,
        HANDLE_LINE,
        `  /** Register routes under a shared prefix: \`app.group("/api", (r) => r.get("/users", h))\`. */
  group(prefix: string, register: (r: Router) => void): this {
    const sub = new Router();
    register(sub);
    for (const route of sub.routes) {
      this.on(route.method, [...split(prefix), ...route.segments].join("/"), route.handler);
    }
    return this;
  }

`,
      );
      f.write(
        this.test,
        `${header}import { Router } from "../src/index";

describe("group", () => {
  const app = new Router().group("/api/v1", (r) =>
    r.get("/users/:id", (_r, { params }) => Response.json(params)).get("/", () => new Response("api")),
  );

  test("prefixes routes", async () => {
    const res = await app.handle(new Request("http://x/api/v1/users/7"));
    expect(await res.json()).toEqual({ id: "7" });
  });

  test("the group's root", async () => {
    expect(await (await app.handle(new Request("http://x/api/v1"))).text()).toBe("api");
  });
});
`,
      );
    },
    note: "Groups flatten into ordinary routes at registration, so matching is unchanged.",
    review: "Flattening at registration keeps `handle()` untouched. LGTM.",
  },
  {
    id: "error-hook",
    title: "Add onError(): turn handler exceptions into responses",
    body: "A throwing handler currently rejects `handle()`. `app.onError((error, req) => …)` catches it and answers instead.",
    regions: ["fields", "handle-dispatch"],
    roles: ["clean"],
    test: "test/errors.test.ts",
    apply(f) {
      after(
        f,
        INDEX,
        FALLBACK_FIELD,
        `  private errorHandler: ((error: unknown, req: Request) => Response | Promise<Response>) | null =
    null;

  /** Answer with \`h\` when a handler throws, instead of rejecting. */
  onError(h: (error: unknown, req: Request) => Response | Promise<Response>): this {
    this.errorHandler = h;
    return this;
  }
`,
      );
      edit(
        f,
        INDEX,
        DISPATCH_RETURN,
        `        const ctx = { params, url, query: url.searchParams };
        if (!this.errorHandler) return route.handler(req, ctx);
        try {
          return await route.handler(req, ctx);
        } catch (error) {
          return this.errorHandler(error, req);
        }
`,
      );
      f.write(
        this.test,
        `${header}import { Router } from "../src/index";

const boom = () => {
  throw new Error("boom");
};

describe("onError", () => {
  test("turns a throw into a response", async () => {
    const app = new Router()
      .get("/", boom)
      .onError((e) => new Response(String((e as Error).message), { status: 500 }));
    const res = await app.handle(new Request("http://x/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("boom");
  });

  test("without a hook the error propagates", async () => {
    const app = new Router().get("/", boom);
    expect(app.handle(new Request("http://x/"))).rejects.toThrow("boom");
  });
});
`,
      );
    },
    note: "Opt-in: without `onError` nothing changes, errors still propagate.",
    review:
      "Good that it's opt-in. Async handlers are awaited inside the try, so rejections are caught too.",
  },
  // ---------------------------------------------------------------- shorthands (conflict pairs)
  {
    id: "all-method",
    title: "Add all(): one handler for every method",
    body: '`app.all("/health", h)` answers any method. Specific routes registered before it still win.',
    regions: ["shorthands", "handle-dispatch"],
    roles: ["pair", "clean"],
    test: "test/all.test.ts",
    apply(f) {
      after(f, INDEX, DELETE_LINE, `  all(p: string, h: Handler) { return this.on("*", p, h); }\n`);
      edit(f, INDEX, DISPATCH_IF, `if (route.method === "*" || route.method === req.method || (`);
      f.write(
        this.test,
        `${header}import { Router } from "../src/index";
${req}
describe("all", () => {
  const app = new Router()
    .get("/x", () => new Response("get"))
    .all("/x", (r) => new Response(\`any \${r.method}\`));

  test("matches any method", async () => {
    expect(await (await app.handle(req("PUT", "/x"))).text()).toBe("any PUT");
  });

  test("earlier specific routes win", async () => {
    expect(await (await app.handle(req("GET", "/x"))).text()).toBe("get");
  });
});
`,
      );
    },
    note: "Uses `*` as the method so `on()` needs no new code path.",
    review:
      "Matching `*` before the 405 check means `all()` routes never produce a 405. Makes sense.",
  },
  {
    id: "options-method",
    title: "Answer OPTIONS automatically, add options()",
    body: "An OPTIONS request to a known path now answers 204 with an `Allow` header instead of 405. `app.options(p, h)` overrides it.",
    regions: ["shorthands", "handle-405"],
    roles: ["pair", "clean"],
    test: "test/options.test.ts",
    apply(f) {
      after(
        f,
        INDEX,
        DELETE_LINE,
        `  options(p: string, h: Handler) { return this.on("OPTIONS", p, h); }\n`,
      );
      after(
        f,
        INDEX,
        ALLOWED_IF,
        `      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { Allow: [...allowed, "OPTIONS"].join(", ") },
        });
      }
`,
      );
      f.write(
        this.test,
        `${header}import { Router } from "../src/index";
${req}
describe("OPTIONS", () => {
  test("automatic 204 with Allow", async () => {
    const app = new Router().get("/users", () => new Response()).post("/users", () => new Response());
    const res = await app.handle(req("OPTIONS", "/users"));
    expect(res.status).toBe(204);
    expect(res.headers.get("Allow")).toBe("GET, POST, OPTIONS");
  });

  test("an explicit options() route wins", async () => {
    const app = new Router().options("/x", () => new Response("custom"));
    expect(await (await app.handle(req("OPTIONS", "/x"))).text()).toBe("custom");
  });
});
`,
      );
    },
    note: "Unknown paths still 404; only paths with routes answer OPTIONS.",
    review: "204 + `Allow` is what clients expect for a preflight-less OPTIONS. LGTM.",
  },
  {
    id: "patch-method",
    title: "Add the patch() shorthand",
    body: "`get`, `post`, `put` and `delete` have shorthands; `patch` didn't.",
    regions: ["shorthands"],
    roles: ["pair", "clean"],
    test: "test/patch.test.ts",
    apply(f) {
      after(
        f,
        INDEX,
        DELETE_LINE,
        `  patch(p: string, h: Handler) { return this.on("PATCH", p, h); }\n`,
      );
      f.write(
        this.test,
        `${header}import { Router } from "../src/index";
${req}
describe("patch", () => {
  test("routes PATCH", async () => {
    const app = new Router().patch("/items/:id", (_r, { params }) => new Response(params.id));
    expect(await (await app.handle(req("PATCH", "/items/9"))).text()).toBe("9");
  });
});
`,
      );
    },
    note: "One line plus a test.",
    review: "Trivial and consistent with the other shorthands.",
  },
  {
    id: "multi-method",
    title: "Add route(methods, pattern, handler)",
    body: 'Register one handler for several methods at once: `app.route(["GET", "HEAD"], "/feed", h)`.',
    regions: ["shorthands"],
    roles: ["pair", "clean"],
    test: "test/route.test.ts",
    apply(f) {
      after(
        f,
        INDEX,
        DELETE_LINE,
        `  route(methods: string[], p: string, h: Handler) {
    for (const m of methods) this.on(m, p, h);
    return this;
  }
`,
      );
      f.write(
        this.test,
        `${header}import { Router } from "../src/index";
${req}
describe("route", () => {
  const app = new Router().route(["PUT", "POST"], "/doc", (r) => new Response(r.method));

  test("each method", async () => {
    expect(await (await app.handle(req("PUT", "/doc"))).text()).toBe("PUT");
    expect(await (await app.handle(req("POST", "/doc"))).text()).toBe("POST");
  });

  test("others are 405", async () => {
    expect((await app.handle(req("GET", "/doc"))).status).toBe(405);
  });
});
`,
      );
    },
    note: "Reuses `on()` per method, so 405s list every method.",
    review: "Simple loop over `on()`; the 405 test covers the interesting part.",
  },
  // ---------------------------------------------------------------- matching (breakers)
  {
    id: "optional-params",
    title: "Support optional params: /posts/:slug?",
    body: "A trailing `:name?` segment may be missing: `/posts/:slug?` matches `/posts` and `/posts/hello`.",
    regions: ["match"],
    roles: ["breaker", "clean"],
    test: "test/optional-params.test.ts",
    apply(f) {
      edit(
        f,
        INDEX,
        PART_MISSING,
        `    const optional = seg.startsWith(":") && seg.endsWith("?");
    if (part === undefined) return optional ? params : null;
`,
      );
      // Param names drop the "?" (param constraints, if present, already parse names).
      const src = f.read(INDEX);
      if (src.includes(PLAIN_NAME)) {
        edit(
          f,
          INDEX,
          PLAIN_NAME,
          `params[seg.slice(1).replace(/\\?$/, "")] = decodeURIComponent(part);`,
        );
      }
      f.write(
        this.test,
        `${header}import { Router } from "../src/index";

describe("optional params", () => {
  const app = new Router().get("/posts/:slug?", (_r, { params }) => Response.json(params));

  test("present", async () => {
    expect(await (await app.handle(new Request("http://x/posts/hello"))).json()).toEqual({
      slug: "hello",
    });
  });

  test("missing", async () => {
    expect(await (await app.handle(new Request("http://x/posts"))).json()).toEqual({});
  });
});
`,
      );
    },
    buggy(f) {
      this.apply(f);
      // The slip: dropping the length check "so optional segments can be missing".
      edit(f, INDEX, MATCH_END, `  return params; // optional segments may be missing\n`);
    },
    fix(f) {
      edit(f, INDEX, `  return params; // optional segments may be missing\n`, MATCH_END);
      const t = f.read(this.test);
      f.write(
        this.test,
        t.replace(
          /\n\}\);\n$/,
          `

  test("extra segments still 404", async () => {
    expect((await app.handle(new Request("http://x/posts/a/b"))).status).toBe(404);
  });
});
`,
        ),
      );
    },
    fixMessage:
      "Keep the exact-length check\n\nOptional params end a match early on their own; dropping the length check let `/` match every path (router.test.ts: 404 and 405 cases).",
    note: "Only a trailing optional segment is supported for now.",
    review:
      "The early return for a missing optional segment is neat. Is a non-trailing `:a?` worth a test?",
  },
  {
    id: "param-constraints",
    title: "Support param constraints: /items/:id(\\d+)",
    body: "A param may carry a regular expression in parentheses; a value that doesn't match doesn't match the route.",
    regions: ["match"],
    roles: ["breaker", "clean"],
    test: "test/constraints.test.ts",
    apply(f) {
      editRe(f, INDEX, PARAM_ASSIGN, constraintMatch(CONSTRAINT));
      f.write(
        this.test,
        `${header}import { Router } from "../src/index";

describe("param constraints", () => {
  const app = new Router().get("/items/:id(\\\\d+)", (_r, { params }) => Response.json(params));

  test("a matching value", async () => {
    expect(await (await app.handle(new Request("http://x/items/42"))).json()).toEqual({ id: "42" });
  });

  test("a value that doesn't match", async () => {
    expect((await app.handle(new Request("http://x/items/abc"))).status).toBe(404);
  });
});
`,
      );
    },
    buggy(f) {
      this.apply(f);
      // The slip: the constraint group isn't optional, so plain `:id` stops being a param.
      edit(f, INDEX, CONSTRAINT, CONSTRAINT_BUGGY);
    },
    fix(f) {
      edit(f, INDEX, CONSTRAINT_BUGGY, CONSTRAINT);
    },
    fixMessage:
      "Make the constraint optional in the param pattern\n\nWithout `?` on the group, plain `:id` segments were compared as static text (router.test.ts: named params).",
    note: "Constraints are anchored (`^…$`), so `\\d+` can't match `12abc`.",
    review:
      "Anchoring the constraint is the right default. Compiling the RegExp once per route would be a nice follow-up.",
  },
];

function constraintMatch(pattern: string): string {
  return `    const param = ${pattern}.exec(seg);
    if (param) {
      const value = decodeURIComponent(part);
      if (param[2] && !new RegExp(\`^(?:\${param[2]})$\`).test(value)) return null;
      params[param[1]!] = value;
    } else if (seg !== part) return null;
`;
}

export function feature(id: string): Feature {
  const f = FEATURES.find((x) => x.id === id);
  if (!f) throw new Error(`No feature ${id}`);
  return f;
}

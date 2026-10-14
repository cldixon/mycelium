# tinyroute

A small HTTP router for fetch-style handlers (Workers, Bun, Deno).

```ts
import { Router } from "tinyroute";

const app = new Router()
  .get("/", () => new Response("hello"))
  .get("/users/:id", (_req, { params }) => Response.json({ id: params.id }));

export default { fetch: (req: Request) => app.handle(req) };
```


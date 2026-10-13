import { describe, expect, test } from "bun:test";
import { Router } from "../src/index";

const req = (method: string, path: string) => new Request(`http://x${path}`, { method });

describe("Router", () => {
  const app = new Router()
    .get("/", () => new Response("root"))
    .get("/users/:id", (_r, { params }) => Response.json(params))
    .post("/users", () => new Response("created", { status: 201 }))
    .get("/files/*", (_r, { params }) => new Response(params["*"]));

  test("static route", async () => {
    expect(await (await app.handle(req("GET", "/"))).text()).toBe("root");
  });

  test("named params are decoded", async () => {
    expect(await (await app.handle(req("GET", "/users/a%20b"))).json()).toEqual({ id: "a b" });
  });

  test("wildcard captures the rest", async () => {
    expect(await (await app.handle(req("GET", "/files/a/b.txt"))).text()).toBe("a/b.txt");
  });

  test("405 with Allow header", async () => {
    const res = await app.handle(req("DELETE", "/users"));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  test("HEAD falls back to GET", async () => {
    expect((await app.handle(req("HEAD", "/"))).status).toBe(200);
  });

  test("404 and custom notFound", async () => {
    expect((await app.handle(req("GET", "/nope"))).status).toBe(404);
    const custom = new Router().notFound(() => new Response("gone", { status: 410 }));
    expect((await custom.handle(req("GET", "/x"))).status).toBe(410);
  });

  test("query params on context", async () => {
    const q = new Router().get("/s", (_r, { query }) => new Response(query.get("q") ?? ""));
    expect(await (await q.handle(req("GET", "/s?q=fungi"))).text()).toBe("fungi");
  });
});

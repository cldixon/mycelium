import { describe, expect, test } from "bun:test";
import { parseRemote, pickEventsQueue, subscribeRepo, unsubscribeRepo } from "./subscriptions.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const REMOTE = `https://${ACCOUNT}.artifacts.cloudflare.net/git/myc-x/tiny.git`;

test("parseRemote", () => {
  expect(parseRemote(REMOTE)).toEqual({ accountId: ACCOUNT, namespace: "myc-x", repo: "tiny" });
  expect(parseRemote("https://example.com/x.git")).toBeNull();
});

describe("pickEventsQueue", () => {
  const q = (name: string, consumer?: string) => ({
    queue_id: `id-${name}`,
    queue_name: name,
    consumers: consumer ? [{ script: consumer }] : [],
  });
  const queues = [
    q("other-events", "other"),
    q("myc-x-events", "myc-x"),
    q("myc-x-jobs", "myc-x"),
    q("stray-events"),
  ];

  test("by namespace, then workers.dev host, then the only candidate", () => {
    expect(pickEventsQueue(queues, { namespace: "myc-x" })?.queue_id).toBe("id-myc-x-events");
    expect(
      pickEventsQueue(queues, { namespace: "custom-ns", host: "myc-x.someone.workers.dev" })
        ?.queue_id,
    ).toBe("id-myc-x-events");
    expect(pickEventsQueue(queues, { namespace: "custom-ns" })).toBeNull(); // two candidates
    expect(pickEventsQueue([q("solo-events", "solo")], {})?.queue_id).toBe("id-solo-events");
  });
});

describe("subscribeRepo", () => {
  test("fails soft without a token", async () => {
    expect(await subscribeRepo(undefined, REMOTE)).toBeNull();
    expect(await unsubscribeRepo(undefined, `${ACCOUNT}:s1`)).toBe(false);
  });

  test("finds the queue and subscribes", async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method!, url, body: init.body && JSON.parse(String(init.body)) });
      if (url.includes("/queues")) {
        return Response.json({
          success: true,
          result: [
            { queue_id: "q1", queue_name: "myc-x-events", consumers: [{ script: "myc-x" }] },
          ],
        });
      }
      return Response.json({ success: true, result: { id: "s1" } });
    }) as unknown as typeof fetch;
    const sub = await subscribeRepo("tok", REMOTE, "myc-x.a.workers.dev", fetcher);
    expect(sub).toBe(`${ACCOUNT}:s1`);
    expect(calls[1].body).toMatchObject({
      source: { type: "artifacts.repo", namespace: "myc-x", repo_name: "tiny" },
      destination: { type: "queues.queue", queue_id: "q1" },
      events: ["pushed"],
    });
    expect(await unsubscribeRepo("tok", sub, fetcher)).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/event_subscriptions/subscriptions/s1`,
    });
  });

  test("fails soft when the API refuses", async () => {
    const fetcher = (async () =>
      Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 403 },
      )) as unknown as typeof fetch;
    expect(
      await subscribeRepo("tok", REMOTE.replace("myc-x", "myc-y"), undefined, fetcher),
    ).toBeNull();
  });
});

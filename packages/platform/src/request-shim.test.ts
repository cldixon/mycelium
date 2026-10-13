import { expect, test } from "bun:test";

test('the Workers Request shim maps redirect "error" to "manual" and keeps instanceof working', async () => {
  const Native = globalThis.Request;
  const native = new Native("https://x.test");
  const { installWorkersRequestShim } = await import("./oauth.ts");
  try {
    installWorkersRequestShim(true);
    const shimmed = new Request("https://x.test", { redirect: "error" });
    expect(shimmed.redirect).toBe("manual");
    expect(new Request("https://x.test", { redirect: "follow" }).redirect).toBe("follow");
    // Requests created before the shim, as the runtime's own are, still count.
    expect(native instanceof Request).toBe(true);
    expect(shimmed instanceof Native).toBe(true);
  } finally {
    globalThis.Request = Native;
    delete (globalThis as { __myceliumRequestShim?: true }).__myceliumRequestShim;
  }
});

import { defineWranglerConfig } from "wrangler/experimental-config";

// cf builds this Worker with the Wrangler bundler. Settings that cf's own
// config does not cover yet live here.
export default defineWranglerConfig({
  assetsDirectory: "./web/build",
  dev: {
    // Keep a loopback origin under `cf dev`, so OAuth can use an AT Protocol
    // loopback client.
    port: 8787,
    host: "127.0.0.1:8787",
  },
});

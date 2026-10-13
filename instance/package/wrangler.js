import { join } from "path";
import { defineWranglerConfig } from "wrangler/experimental-config";

// cf builds the Worker with the Wrangler bundler; the assets directory and the
// dev server's address are set here. The address keeps requests' loopback
// origin under `mycelium dev`, so OAuth can use an AT Protocol loopback client.
export default defineWranglerConfig({
  assetsDirectory: join(import.meta.dirname, "web"),
  dev: { port: 8787, host: "127.0.0.1:8787" },
});

import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// In dev the SPA runs on Vite (for HMR) and the API runs in `cf dev`.
// In production both are one Worker.
const WORKER_ORIGIN = process.env.MYCELIUM_WORKER_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), resolve(__dirname, "..")],
    },
    proxy: {
      "/api": WORKER_ORIGIN,
      "/health": WORKER_ORIGIN,
      "/oauth": WORKER_ORIGIN,
    },
  },
});

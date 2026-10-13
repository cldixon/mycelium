import { defineMycelium } from "./config.ts";

// The owner's settings (Worker name, namespace, domain, title) come from
// mycelium.config.json; see config.ts. Nothing specific to one instance
// belongs in this file.
export default defineMycelium({ dir: import.meta.dirname, entrypoint: "./src/worker.ts" });

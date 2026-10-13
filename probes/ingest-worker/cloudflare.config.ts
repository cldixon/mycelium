import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "mycelium-ingest",
		compatibilityDate: "2026-10-06",
		entrypoint,
		env: {
			DB: bindings.d1({ name: "mycelium-dev-index" }),
			ARTIFACTS: bindings.artifacts({ namespace: "mycelium-dev" }),
			NAMESPACE: bindings.text("mycelium-dev"),
			EVENTS_QUEUE_ID: bindings.text("b679a9fa6d824bf18406dda30debe9b9"),
			CF_ACCOUNT_ID: bindings.secret(),
			CF_API_TOKEN: bindings.secret(),
			ADMIN_KEY: bindings.secret(),
		},
		triggers: [triggers.queue({ name: "mycelium-dev-events", maxBatchSize: 50, maxBatchTimeout: 2 })],
	},
});

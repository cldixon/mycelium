import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const gitRunner = defineContainer({
	name: "mycelium-git-runner",
	image: { dockerfile: "./container/Dockerfile" },
	instanceType: "basic",
	maxInstances: 5,
});

export default defineConfig({
	worker: {
		name: "mycelium-git",
		compatibilityDate: "2026-10-06",
		entrypoint,
		env: {
			ARTIFACTS: bindings.artifacts({ namespace: "mycelium-dev" }),
			ADMIN_KEY: bindings.secret(),
			GIT_RUNNER: bindings.durableObject({ worker: "mycelium-git", exportName: "GitRunner" }),
		},
		exports: {
			GitRunner: exports.durableObject({ storage: "sqlite", container: gitRunner }),
		},
	},
	containers: [gitRunner],
});

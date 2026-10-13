import { expect, test } from "bun:test";
import { scaffoldFiles } from "./files.ts";

const options = {
  name: "my-forge",
  packageName: "@mycelium/instance",
  packageSpec: "^0.1.0",
  cfVersion: "1.0.0-beta.14",
  wranglerVersion: "^4.149.0",
  workflow: true,
};

test("a deploy folder that depends on the instance package", () => {
  const files = scaffoldFiles(options);
  expect(Object.keys(files).sort()).toEqual([
    ".github/workflows/deploy.yml",
    ".gitignore",
    "README.md",
    "cloudflare.config.ts",
    "package.json",
    "wrangler.config.ts",
  ]);
  const pkg = JSON.parse(files["package.json"]!);
  expect(pkg.name).toBe("my-forge");
  expect(pkg.dependencies).toEqual({
    "@mycelium/instance": "^0.1.0",
    cf: "1.0.0-beta.14",
    wrangler: "^4.149.0",
  });
  expect(pkg.scripts.deploy).toBe("mycelium deploy");
  expect(files["cloudflare.config.ts"]).toContain(
    'import { defineMycelium } from "@mycelium/instance/config"',
  );
  expect(files["wrangler.config.ts"]).toContain('"@mycelium/instance/wrangler"');
  // The owner's settings are committed; build output is not.
  expect(files[".gitignore"]).not.toContain("mycelium.config.json");
});

test("the deploy workflow skips without a token", () => {
  const workflow = scaffoldFiles(options)[".github/workflows/deploy.yml"]!;
  expect(workflow).toContain("if: env.CLOUDFLARE_API_TOKEN == ''");
  expect(workflow).toContain("bun run deploy");
  expect(Object.keys(scaffoldFiles({ ...options, workflow: false }))).not.toContain(
    ".github/workflows/deploy.yml",
  );
});

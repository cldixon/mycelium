/**
 * The files of a Mycelium deploy folder: the owner's own repo, holding their
 * settings and depending on the published instance package.
 */
export type ScaffoldOptions = {
  /** The folder's package name. */
  name: string;
  /** The instance package's name, e.g. @mycelium/instance. */
  packageName: string;
  /** What to install it from: a version range, a tarball path or a URL. */
  packageSpec: string;
  cfVersion: string;
  wranglerVersion: string;
  /** Add .github/workflows/deploy.yml. */
  workflow: boolean;
};

export function scaffoldFiles(o: ScaffoldOptions): Record<string, string> {
  const files: Record<string, string> = {
    "package.json":
      JSON.stringify(
        {
          name: o.name,
          private: true,
          type: "module",
          scripts: {
            setup: "mycelium setup",
            deploy: "mycelium deploy",
            dev: "mycelium dev",
            secrets: "mycelium secrets",
          },
          dependencies: {
            [o.packageName]: o.packageSpec,
            cf: o.cfVersion,
            wrangler: o.wranglerVersion,
          },
        },
        null,
        2,
      ) + "\n",
    "cloudflare.config.ts": `import { defineMycelium } from "${o.packageName}/config";

// Your settings are in mycelium.config.json (\`bun run setup\` writes it).
export default defineMycelium({ dir: import.meta.dirname });
`,
    "wrangler.config.ts": `export { default } from "${o.packageName}/wrangler";\n`,
    ".gitignore": "node_modules/\n.cloudflare/\n.wrangler/\n.env\n",
    "README.md": readme(o),
  };
  if (o.workflow) files[".github/workflows/deploy.yml"] = WORKFLOW;
  return files;
}

function readme(o: ScaffoldOptions): string {
  return `# My Mycelium

A [Mycelium](https://github.com/cldixon/mycelium) instance: private git repos, pull requests and
workflows in my own Cloudflare account. Its settings are in \`mycelium.config.json\`; the code comes
from [\`${o.packageName}\`](https://www.npmjs.com/package/${o.packageName}).

| Command             | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| \`bun run setup\`   | Change the settings and create the queues (re-run any time)                |
| \`bun run deploy\`  | Deploy. The first deploy prints the setup code that claims the instance    |
| \`bun run dev\`     | Run it locally on http://127.0.0.1:8787                                    |
| \`bun run secrets\` | New setup code and OAuth key (before claiming only)                        |

Deploying needs Docker running: it builds the runner container image (git, node and bun, for
merges and workflow steps).

**Push events (optional):** with a \`CF_API_TOKEN\` secret on the Worker, pushes start workflows
and update pull requests; without it, run workflows by hand. Create a Cloudflare API token that
can manage event subscriptions and queues on your account, then
\`CF_API_TOKEN=<token> bunx mycelium secrets cf-api-token\`.

**Update Mycelium:** \`bun update ${o.packageName} && bun run deploy\`. Migrations apply themselves.
${
  o.workflow
    ? `
**Deploy on push (optional):** \`.github/workflows/deploy.yml\` deploys every push to \`main\` once
this repo has the secret \`CLOUDFLARE_API_TOKEN\` (a Cloudflare API token from the "Edit Cloudflare
Workers" template, plus D1, Queues and Containers Edit). Until then it skips, and \`bun run deploy\`
from your machine is all you need. GitHub-hosted runners have Docker, which the deploy needs. To
add the secret: \`gh secret set CLOUDFLARE_API_TOKEN\`, or the repo's Settings, then Secrets and
variables, then Actions.
`
    : ""
}`;
}

const WORKFLOW = `name: Deploy

# Deploys this Mycelium instance on every push to main, using the repo secret
# CLOUDFLARE_API_TOKEN. Without the secret, it skips with a notice. The deploy
# builds the runner's container image, so it needs Docker, which GitHub-hosted
# runners have.
on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
    steps:
      - name: No token, no deploy
        if: env.CLOUDFLARE_API_TOKEN == ''
        run: echo "::notice::Not deploying. Add the CLOUDFLARE_API_TOKEN repo secret to deploy on push."
      - uses: actions/checkout@v5
        if: env.CLOUDFLARE_API_TOKEN != ''
      - uses: oven-sh/setup-bun@v2
        if: env.CLOUDFLARE_API_TOKEN != ''
      - run: bun install --frozen-lockfile
        if: env.CLOUDFLARE_API_TOKEN != ''
      - run: bun run deploy
        if: env.CLOUDFLARE_API_TOKEN != ''
`;

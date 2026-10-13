# The Mycelium runner, as the published @mycelium/instance package builds it:
# git + node + bun, driven by the instance Worker through POST /jobs. Build
# context is this folder, which holds the bundled server.
#
# Keep in step with runner/Dockerfile in the mycelium repo. The difference:
# bun comes from its official image (pinned when the package is packed), not
# from a binary next to this file, so owners need nothing but Docker.
FROM mirror.gcr.io/oven/bun:__BUN_VERSION__-slim AS bun
FROM mirror.gcr.io/library/node:22-bookworm-slim AS node

FROM mirror.gcr.io/library/buildpack-deps:bookworm-scm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && ln -s bun /usr/local/bin/bunx \
  && node --version && bun --version && git --version \
  && git config --system user.name "mycelium" \
  && git config --system user.email "runner@mycelium.invalid" \
  && mkdir -p /work
WORKDIR /app
COPY server.js ./
EXPOSE 8080
CMD ["bun", "run", "server.js"]

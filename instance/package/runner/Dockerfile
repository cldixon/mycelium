# The Mycelium runner, as the published @mycelium/instance package builds it:
# git + node (Debian node:22) + bun, driven by the instance Worker through
# POST /jobs. Build context is this folder, which holds the bundled server.
#
# Keep in step with runner/Dockerfile in the mycelium repo. The difference:
# bun comes from its official image (pinned when the package is packed), not
# from a binary next to this file, so owners need nothing but Docker.
FROM mirror.gcr.io/oven/bun:__BUN_VERSION__-slim AS bun

FROM mirror.gcr.io/library/node:22
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN bun --version && git --version \
  && git config --system user.name "mycelium" \
  && git config --system user.email "runner@mycelium.invalid" \
  && mkdir -p /work
WORKDIR /app
COPY server.js ./
EXPOSE 8080
CMD ["bun", "run", "server.js"]

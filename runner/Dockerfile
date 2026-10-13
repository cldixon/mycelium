# The Mycelium runner: git + node + bun, driven by the instance Worker through
# POST /jobs. Build context is runner/.
#
# Slim on purpose (cold starts pull the image): Debian's buildpack-deps:scm
# (git, curl, ssh, CA certificates; ~150 MB) with node copied from
# node:22-slim, rather than the full node:22 (~450 MB). No package installs,
# so the build needs no Debian mirror. Images come through mirror.gcr.io
# (Docker Hub is rate-limited from our dev environment).
#
# bun is copied in as a single binary. Before building or deploying:
#
#   cp "$(which bun)" runner/bun
#
# runner/bun is gitignored; never commit it.
FROM mirror.gcr.io/library/node:22-bookworm-slim AS node

FROM mirror.gcr.io/library/buildpack-deps:bookworm-scm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY bun /usr/local/bin/bun
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && ln -s bun /usr/local/bin/bunx \
  && node --version && bun --version && git --version \
  && git config --system user.name "mycelium" \
  && git config --system user.email "runner@mycelium.invalid" \
  && mkdir -p /work
WORKDIR /app
COPY package.json ./
COPY src ./src
EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]

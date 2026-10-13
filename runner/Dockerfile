# The Mycelium runner: git + node (Debian node:22) + bun, driven by the instance
# Worker through POST /jobs. Build context is runner/.
#
# bun is copied in as a single binary (Docker Hub is rate-limited from our dev
# environment, hence mirror.gcr.io). Before building or deploying:
#
#   cp "$(which bun)" runner/bun
#
# runner/bun is gitignored; never commit it.
FROM mirror.gcr.io/library/node:22
COPY bun /usr/local/bin/bun
RUN bun --version && git --version \
  && git config --system user.name "mycelium" \
  && git config --system user.email "runner@mycelium.invalid" \
  && mkdir -p /work
WORKDIR /app
COPY package.json ./
COPY src ./src
EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]

# node:22 (Debian) ships with git; bun is copied in as a single binary.
# Before building: cp "$(which bun)" container/bun   (Docker Hub and Alpine mirrors are blocked in our cloud env).
FROM mirror.gcr.io/library/node:22
COPY bun /usr/local/bin/bun
RUN bun --version && git --version
WORKDIR /app
COPY server.ts .
EXPOSE 8080
CMD ["bun", "run", "server.ts"]

# Alpine uses musl, so the glibc prebuilds of better-sqlite3 are never used and
# the native binding is compiled against the runtime libc instead. That avoids
# the glibc version mismatch a slim Debian image runs into.
FROM node:24-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Ignore any prebuilt binary and compile, so the binding matches this libc.
ENV npm_config_build_from_source=true

RUN apk add --no-cache python3 make g++

RUN corepack enable

WORKDIR /app

# Manifests first, so a source-only change reuses the installed dependencies.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/tunnelcode-cli/package.json apps/tunnelcode-cli/
COPY apps/tunnelcode-server/package.json apps/tunnelcode-server/
COPY packages/config/package.json packages/config/
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Collect the server plus only its production dependencies. --legacy copies
# workspace packages instead of injecting them, which keeps the compiled native
# binding of better-sqlite3 intact.
RUN pnpm --filter tunnelcode-server --prod deploy --legacy /deploy

# pnpm 11.20+ creates symlinks for workspace packages that point back into the
# build workspace. Docker COPY preserves symlinks, so the runtime stage would get
# dangling links to paths that only existed in the build stage. Replacing each
# with a dereferenced copy (-L follows symlinks inside) makes them self-contained.
# Their own dependencies (like zod) also live in the build tree, so those are
# copied alongside.
RUN find /deploy/node_modules/@tunnelcode -maxdepth 1 -type l | while read link; do \
      target=$(readlink -f "$link") && \
      rm "$link" && \
      cp -rL "$target" "$link"; \
    done

# Strip debug symbols from native bindings and remove files unused at runtime.
# Prebuilds for other platforms (darwin, win32) are deleted; the linuxmusl prebuild
# is what the runtime actually loads. The deps/ and src/ directories are compile-time
# only. node-addon-api headers and @types are not needed at runtime either.
RUN find /deploy -path "*/prebuilds/darwin-*" -delete && \
    find /deploy -path "*/prebuilds/win32-*" -delete && \
    find /deploy -path "*/prebuilds/linux-x64*" -delete && \
    find /deploy -path "*/better-sqlite3/deps" -type d -exec rm -rf {} + && \
    find /deploy -path "*/better-sqlite3/src" -type d -exec rm -rf {} + && \
    find /deploy -path "*/better-sqlite3/binding.gyp" -delete && \
    find /deploy -path "*/@types" -type d -exec rm -rf {} + && \
    find /deploy -path "*/node-addon-api" -type d -exec rm -rf {} + && \
    find /deploy -name "*.node" -exec strip --strip-all {} \; 2>/dev/null || true && \
    find /deploy/node_modules \( \
      -name "*.md" -o -name "*.ts" -o -name "*.map" \
      -o -name "LICENSE*" -o -name "CHANGELOG*" \
      -o -name "*.d.ts" -o -name "*.d.ts.map" \
    \) -delete

# ─── Runtime: minimal Alpine with only the node binary ───────────────────────
FROM alpine:3.24 AS runtime

RUN apk add --no-cache nodejs

# Links the image to the repository, which is what makes GITHUB_TOKEN allowed to
# push it and lets the package inherit the repository's public visibility.
LABEL org.opencontainers.image.source=https://github.com/adityadarma/tunnelcode
LABEL org.opencontainers.image.description="Run an AI coding agent locally and control it from a browser."
LABEL org.opencontainers.image.licenses=MIT

ENV NODE_ENV=production
# Listens on every interface because access is controlled by the published port.
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_FILE=/app/data/tunnelcode.sqlite

WORKDIR /app

COPY --from=build --chown=nobody:nobody /deploy ./

# The database directory is created inside /app so everything belongs to one user
# and one volume mount covers both code and data.
RUN mkdir -p /app/data && chown nobody:nobody /app/data

USER nobody

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

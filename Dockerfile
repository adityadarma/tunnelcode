# Alpine uses musl, so the glibc prebuilds of better-sqlite3 are never used and
# the native binding is compiled against the runtime libc instead. That avoids
# the glibc version mismatch a slim Debian image runs into.
FROM node:22-alpine AS build

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

FROM node:22-alpine AS runtime

# Links the image to the repository, which is what makes GITHUB_TOKEN allowed to
# push it and lets the package inherit the repository's public visibility.
LABEL org.opencontainers.image.source=https://github.com/adityadarma/tunnelcode
LABEL org.opencontainers.image.description="Run an AI coding agent locally and control it from a browser."
LABEL org.opencontainers.image.licenses=MIT

ENV NODE_ENV=production
# Listens on every interface because access is controlled by the published port.
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_FILE=/data/tunnelcode.sqlite

WORKDIR /app

COPY --from=build /deploy ./

# The database lives on a volume so conversations survive a new image.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

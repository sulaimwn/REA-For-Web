FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY packages/ask/package.json ./packages/ask/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY apps/worker ./apps/worker
COPY packages/schema ./packages/schema
COPY packages/rea-adapter ./packages/rea-adapter
COPY packages/pipeline ./packages/pipeline
RUN npm ci --ignore-scripts --workspace=@rea-studio/worker --include-workspace-root --no-audit --no-fund \
    && npm run build --workspace=@rea-studio/schema \
    && npm run build --workspace=@rea-studio/rea-adapter \
    && npm run build --workspace=@rea-studio/pipeline \
    && npm run build --workspace=@rea-studio/worker

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
# REA checks ownership of its trusted parser subprocesses using ps.
RUN apt-get update && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/rea
COPY apps/worker/rea-runtime/package.json apps/worker/rea-runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && node -e "if (require('./node_modules/rea-agents/package.json').version !== '6.8.0') process.exit(1)"
COPY --from=build /build/apps/worker/dist /opt/worker/
COPY apps/worker/package.json /opt/worker/package.json
COPY --from=build /build/packages/rea-adapter/dist /opt/worker/node_modules/@rea-studio/rea-adapter/dist
COPY packages/rea-adapter/package.json /opt/worker/node_modules/@rea-studio/rea-adapter/package.json
COPY --from=build /build/packages/schema/dist /opt/worker/node_modules/@rea-studio/schema/dist
COPY packages/schema/package.json /opt/worker/node_modules/@rea-studio/schema/package.json
RUN mkdir /input && chmod 755 /input
LABEL rea-studio.owner-protocol="1"
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/worker/container-entrypoint.js"]

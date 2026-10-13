FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY packages/ask/package.json ./packages/ask/package.json
COPY apps/worker ./apps/worker
COPY packages/schema ./packages/schema
COPY packages/rea-adapter ./packages/rea-adapter
COPY packages/pipeline ./packages/pipeline
RUN npm ci --ignore-scripts --workspace=@rea-studio/worker --include-workspace-root --no-audit --no-fund \
    && npm run build --workspace=@rea-studio/schema \
    && npm run build --workspace=@rea-studio/rea-adapter \
    && npm run build --workspace=@rea-studio/pipeline \
    && npm run build --workspace=@rea-studio/worker

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
# REA checks ownership of its trusted parser subprocesses using ps.
RUN apt-get update && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/rea
COPY apps/worker/rea-runtime/package.json apps/worker/rea-runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && node -e "if (require('./node_modules/rea-agents/package.json').version !== '6.4.0') process.exit(1)"
COPY --from=build /build/apps/worker/dist /opt/worker/
COPY apps/worker/package.json /opt/worker/package.json
COPY --from=build /build/packages/rea-adapter/dist /opt/worker/node_modules/@rea-studio/rea-adapter/dist
COPY packages/rea-adapter/package.json /opt/worker/node_modules/@rea-studio/rea-adapter/package.json
COPY --from=build /build/packages/schema/dist /opt/worker/node_modules/@rea-studio/schema/dist
COPY packages/schema/package.json /opt/worker/node_modules/@rea-studio/schema/package.json
RUN mkdir /input && chmod 755 /input
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/worker/container-entrypoint.js"]

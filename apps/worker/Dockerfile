FROM node:24.18.0-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker ./apps/worker
COPY packages/schema ./packages/schema
COPY packages/rea-adapter ./packages/rea-adapter
RUN npm ci --ignore-scripts --workspace=@rea-studio/worker --include-workspace-root --no-audit --no-fund \
    && npm run build:packages && npm run build --workspace=@rea-studio/worker

FROM node:24.18.0-bookworm-slim
WORKDIR /opt/rea
RUN npm install --ignore-scripts --no-audit --no-fund --save-exact rea-agents@6.4.0 \
    && node -e "if (require('./node_modules/rea-agents/package.json').version !== '6.4.0') process.exit(1)"
COPY --from=build /build/apps/worker/dist /opt/worker/
COPY apps/worker/package.json /opt/worker/package.json
RUN mkdir /input && chmod 755 /input
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["node", "/opt/worker/container-entrypoint.js"]

# syntax=docker/dockerfile:1.7
FROM node:20.10.0-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay/package.json packages/relay/
RUN pnpm install --frozen-lockfile
COPY packages/protocol packages/protocol
COPY packages/relay packages/relay
RUN pnpm --filter @covibes/relay build

FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=nonroot:nonroot /app/packages/relay/dist /app/dist
COPY --from=builder --chown=nonroot:nonroot /app/packages/relay/package.json /app/package.json
COPY --from=builder --chown=nonroot:nonroot /app/node_modules /app/node_modules
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:8080/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
CMD ["dist/main.js"]

# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS builder
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

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S relay && adduser -S relay -G relay
COPY --from=builder --chown=relay:relay /app/packages/relay/dist /app/dist
COPY --from=builder --chown=relay:relay /app/packages/relay/package.json /app/package.json
COPY --from=builder --chown=relay:relay /app/node_modules /app/node_modules
USER relay
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

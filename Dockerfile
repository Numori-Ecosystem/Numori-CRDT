# Numori CRDT — multi-tenant Automerge sync service.
#
# Small image: production dependencies only, no build step (the service is plain
# ESM Node), non-root user, and a healthcheck the orchestrator can use.

FROM node:24.18.1-alpine AS deps
WORKDIR /app

# Copy manifests first so dependency installation is cached independently of
# source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.18.1-alpine AS production
WORKDIR /app

ENV NODE_ENV=production \
    CRDT_PORT=3030 \
    CRDT_HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

RUN addgroup -g 1001 -S nodejs \
 && adduser -S crdt -u 1001 -G nodejs \
 && chown -R crdt:nodejs /app
USER crdt

EXPOSE 3030

# /readyz also verifies the database round-trip when one is configured, so an
# instance that cannot persist documents is reported unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CRDT_PORT||3030)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run node directly (not via npm) so it receives SIGTERM as PID 1 and can shut
# down gracefully, flushing documents before exit.
CMD ["node", "src/index.mjs"]

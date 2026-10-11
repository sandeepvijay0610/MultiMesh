# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Airlock backend — multi-stage, Node 18 Alpine, non-root runtime
# ---------------------------------------------------------------------------

# ===========================================================================
# Stage 1 — deps: install only production dependencies in an isolated layer
# ===========================================================================
FROM node:18-alpine AS deps

WORKDIR /app

# Install build-time tooling only if a native module ever needs to compile.
# Kept minimal; drop entirely if you never add native deps.
RUN apk add --no-cache --virtual .build-deps python3 make g++

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json* ./

# Reproducible install of production deps only. Falls back to `npm install`
# if no lockfile is present (fresh clone).
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
 && npm cache clean --force

# Remove build tooling so it never lands in the runtime image.
RUN apk del .build-deps

# ===========================================================================
# Stage 2 — runner: minimal runtime image, non-root user
# ===========================================================================
FROM node:18-alpine AS runner

# tini gives us a proper PID 1 so SIGTERM reaches Node and the graceful
# shutdown handler in server.js actually runs on `docker stop`.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Bring in production node_modules from the deps stage (already chown-able).
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Application source. `.dockerignore` keeps secrets, tests, .git, etc. out.
COPY --chown=node:node . .

# The `node` user (uid 1000) ships with the official Alpine image.
# Switch to it — the container never runs as root.
USER node

EXPOSE 3000

# tini reaps zombies and forwards signals to `node`.
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "server.js"]
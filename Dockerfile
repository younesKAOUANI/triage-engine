# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies for a lean runtime image.
RUN npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the non-root user that the node image already ships with.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Static demo assets, served by useStaticAssets. Not compiled, so they are
# copied straight from the context rather than out of the build stage.
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

# Liveness only. /health is deliberately dependency-free (see HealthController):
# a Postgres blip must not make the orchestrator kill an otherwise healthy
# container. Readiness, which does check the datastores, is what the reverse
# proxy and any rollout should gate on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run on boot when DB_RUN_MIGRATIONS_ON_BOOT=true, which is applied in
# src/config/database.module.ts. With more than one replica, leave it off and run
# `migrate` as a separate step so instances don't race each other at startup.
CMD ["node", "dist/main.js"]

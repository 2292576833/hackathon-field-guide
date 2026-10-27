# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY . .
# No runtime credentials or production database are supplied during image build.
RUN mkdir -p public && npm run build
RUN node --experimental-strip-types scripts/install-dsh.mts --directory /app/.runtime/dsh-runtime
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    APP_MODE=connected \
    FIELD_GUIDE_SERVE=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    PORT=3000 \
    DSH_RUNTIME_PACKAGE_DIRECTORY=/app/.runtime/dsh-runtime/node_modules/@deepseek-ai/dsh
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
# Workers/migration run the repository's TypeScript directly with Node 24.
# This also retains skills catalog-lock.ts and tutorials used by runtime seeding.
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/.runtime/dsh-runtime ./.runtime/dsh-runtime
# .runtime itself must be writable by the runtime user, so the ModelScope Studio
# entrypoint can link postgres-data onto that platform's persistent mount.
RUN chmod 755 .runtime/dsh-runtime scripts/container-entrypoint.sh \
    && chmod 644 .runtime/dsh-runtime/package.json .runtime/dsh-runtime/package-lock.json .runtime/dsh-runtime/runtime-receipt.json \
    && mkdir -p .runtime/dsh-sessions .runtime/server-control .next/cache \
    && chown node:node .runtime .runtime/dsh-sessions .runtime/server-control .next/cache
USER node
# 3000 is the Compose/reverse-proxy port; ModelScope Studio requires 7860.
EXPOSE 3000 7860
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
# Container bind must accept traffic from its network interface, independent of local dev binding.
# PORT is read at runtime so one image serves both Compose (3000) and Studio (7860).
CMD ["sh", "-c", "exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port \"${PORT:-3000}\""]

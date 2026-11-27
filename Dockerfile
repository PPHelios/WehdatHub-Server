# WehdatHub server image for Coolify (or any Docker host). Multi-arch base, so it builds on ARM64 (aarch64) and x86_64.
# sharp ships prebuilt libvips for linux-arm64/x64 glibc, so no apt packages are needed on slim.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    MALLOC_ARENA_MAX=2 \
    PORT=3000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Owned by root and read-only for the app user: the app never writes to disk (files go to Supabase or R2).
COPY . .

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server.js"]

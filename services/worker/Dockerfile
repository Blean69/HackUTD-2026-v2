# Keystone agent worker. Build context: services/worker/   docker build -t keystone-worker services/worker
FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production \
    WORKER_PORT=8787 \
    WORKER_CACHE_DIR=/app/.cache \
    WORKER_TOKEN_FILE=/app/.data/worker-token
EXPOSE 8787
# Config comes from env vars (see README). Mount a volume on /app/.data to keep the worker identity across restarts.
# To seed from a container: mount data/seed and run `npx tsx src/seed.ts` with DATA_DIR pointing at it.
CMD ["npx", "tsx", "src/index.ts"]

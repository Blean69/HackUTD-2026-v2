# syntax=docker/dockerfile:1
# Keystone web (Next.js, standalone output). Build context: apps/web
#   docker build -t keystone-web \
#     --build-arg NEXT_PUBLIC_SPACETIME_URI=wss://db.example.com \
#     --build-arg NEXT_PUBLIC_SPACETIME_DB=keystone \
#     --build-arg NEXT_PUBLIC_WORKER_URL=https://keystone.example.com/worker \
#     --build-arg NEXT_PUBLIC_VOICE_URL=https://keystone.example.com/voice \
#     --build-arg NEXT_PUBLIC_PHONE_NUMBER=+18444681795 .
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so they must be build args.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_SPACETIME_URI=ws://localhost:3000
ARG NEXT_PUBLIC_SPACETIME_DB=keystone
ARG NEXT_PUBLIC_WORKER_URL=http://localhost:8787
ARG NEXT_PUBLIC_VOICE_URL=http://localhost:7860
ARG NEXT_PUBLIC_PHONE_NUMBER=+18444681795
ARG NEXT_PUBLIC_USE_MOCKS=
ENV NEXT_PUBLIC_SPACETIME_URI=$NEXT_PUBLIC_SPACETIME_URI \
    NEXT_PUBLIC_SPACETIME_DB=$NEXT_PUBLIC_SPACETIME_DB \
    NEXT_PUBLIC_WORKER_URL=$NEXT_PUBLIC_WORKER_URL \
    NEXT_PUBLIC_VOICE_URL=$NEXT_PUBLIC_VOICE_URL \
    NEXT_PUBLIC_PHONE_NUMBER=$NEXT_PUBLIC_PHONE_NUMBER \
    NEXT_PUBLIC_USE_MOCKS=$NEXT_PUBLIC_USE_MOCKS
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]

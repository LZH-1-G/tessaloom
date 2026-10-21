FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.7
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ packages/
RUN pnpm install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 22 || minor < 19) process.exit(1)' \
    && apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @qloo/qloo-harness@0.1.26 \
    && groupadd --gid 10001 tl-web && useradd --uid 10001 --gid 10001 --create-home tl-web \
    && groupadd --gid 10002 tl-worker && useradd --uid 10002 --gid 10002 --create-home tl-worker \
    && install -d -m 0700 -o tl-worker -g tl-worker /home/tl-worker/.qloo \
    && qloo --version
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/worker/dist/main.js apps/worker/dist/main.js
COPY scripts/start.mjs scripts/start.mjs
ENV NODE_ENV=production APP_ENV=production TL_ROLE=all PORT=3000 HOSTNAME=0.0.0.0 \
    QLOO_HOME=/home/tl-worker/.qloo TL_WEB_UID=10001 TL_WORKER_UID=10002
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["tini","--"]
CMD ["node","scripts/start.mjs"]

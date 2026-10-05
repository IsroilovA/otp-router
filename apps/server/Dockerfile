FROM node:26.10.0-trixie-slim AS build
WORKDIR /app
RUN npm install --global pnpm@12.8.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json ./packages/engine/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY patches ./patches
RUN pnpm install --filter '@otp-router/server...' --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/engine ./packages/engine
COPY apps/server ./apps/server
RUN pnpm --filter @otp-router/engine build && pnpm --filter @otp-router/server build

FROM node:26.10.0-trixie-slim AS production-dependencies
WORKDIR /app
RUN npm install --global pnpm@12.8.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json ./packages/engine/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY patches ./patches
RUN pnpm install --filter '@otp-router/server...' --frozen-lockfile --prod

FROM node:26.10.0-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/engine/node_modules ./packages/engine/node_modules
COPY --from=production-dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY packages/engine/package.json ./packages/engine/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
RUN mkdir -p /app/apps/server/config
USER node
EXPOSE 3000 3001
CMD ["node", "apps/server/dist/main.js", "--config", "/app/apps/server/config/router.config.ts"]

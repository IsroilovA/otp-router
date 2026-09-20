FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json ./packages/engine/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY examples/custom-adapter/package.json ./examples/custom-adapter/package.json
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/engine ./packages/engine
COPY apps/server ./apps/server
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json ./packages/engine/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY examples/custom-adapter/package.json ./examples/custom-adapter/package.json
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
RUN mkdir -p /app/apps/server/config
USER node
EXPOSE 3000 3001
CMD ["node", "apps/server/dist/main.js", "--config", "/app/apps/server/config/router.config.ts"]

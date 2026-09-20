FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json biome.json .oxlintrc.json ./
COPY src ./src
RUN pnpm build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/config
USER node
EXPOSE 3000 3001
CMD ["node", "dist/main.js", "--config", "/app/config/router.config.ts"]

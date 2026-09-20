# Build from the workspace root: docker build -f examples/custom-adapter/Dockerfile .
FROM node:24-bookworm-slim
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
COPY examples/custom-adapter ./examples/custom-adapter
RUN pnpm --filter @otp-router/engine build && pnpm --filter otp-router-custom-adapter-example build
CMD ["node", "examples/custom-adapter/dist/smoke.js"]
